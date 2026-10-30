import pytest

from emeth.llm.anthropic import prompt_json_fallback, to_anthropic
from emeth.llm.base import extract_json
from emeth.llm.embeddings import cosine, hashed_embedding
from emeth.llm.mock import MockProvider
from emeth.llm.openai_compat import to_openai
from emeth.llm.router import Breaker, BreakerConfig, LLMRouter
from emeth.llm.types import ChatRequest, LLMError, Message, ToolCall


def test_extract_json_handles_fences_and_chatter():
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('Sure! Here it is: {"a": {"b": [1,2]}} hope it helps') == {"a": {"b": [1, 2]}}
    assert extract_json("no json here") is None


def test_message_conversions():
    msgs = [
        Message(role="system", content="sys"),
        Message(role="user", content="hi"),
        Message(role="assistant", content="", tool_calls=[ToolCall(id="t1", name="say", arguments={"text": "yo"})]),
        Message(role="tool", content="ok", tool_call_id="t1"),
        Message(role="user", content="again"),
    ]
    system, conv = to_anthropic(msgs)
    assert system == "sys"
    assert [m["role"] for m in conv] == ["user", "assistant", "user"]  # tool result merged into the next user turn
    assert conv[1]["content"][0]["type"] == "tool_use"
    oa = to_openai(msgs)
    assert oa[0]["role"] == "system" and oa[3]["role"] == "tool"
    fallback = prompt_json_fallback(ChatRequest(messages=msgs[:2], json_schema={"type": "object"}))
    assert "JSON schema" in fallback[-1].content


def test_breaker_opens_after_failures_and_half_opens():
    b = Breaker(BreakerConfig(failure_threshold=2, success_threshold=1, timeout_s=10))
    assert b.allow(now=0)
    b.record(False, "boom", now=0)
    b.record(False, "boom", now=1)
    assert b.state == "open" and not b.allow(now=2)
    assert b.allow(now=12) and b.state == "half_open"
    b.record(True, now=13)
    assert b.state == "closed"


async def test_router_fails_over_on_transient_and_stops_on_deterministic():
    flaky = MockProvider("flaky", responses=[LLMError("rate limited", status=429, retryable=True, provider="flaky")])
    good = MockProvider("good", responses=["fine"])
    router = LLMRouter([flaky, good])
    resp = await router.chat(ChatRequest(messages=[Message(role="user", content="hi")]))
    assert resp.text == "fine" and resp.provider == "good"
    assert router.ledger["flaky"].failures == 1
    bad = MockProvider("bad", responses=[LLMError("bad request", status=400, retryable=False, provider="bad")])
    router2 = LLMRouter([bad, good])
    with pytest.raises(LLMError):
        await router2.chat(ChatRequest(messages=[Message(role="user", content="hi")]))


async def test_router_tier_preferences_and_json():
    a = MockProvider("a", responses=[{"x": 1}])
    b = MockProvider("b", responses=[{"x": 2}])
    router = LLMRouter([a, b], tier_preferences={"smart": ["b"]})
    resp = await router.chat(ChatRequest(messages=[Message(role="user", content="hi")], tier="smart", json_schema={"type": "object"}))
    assert resp.json_data == {"x": 2} and resp.provider == "b"
    health = router.health()
    assert health["b"]["calls"] == 1 and health["b"]["breaker"] == "closed"


async def test_embeddings_fallback_and_similarity():
    v1 = hashed_embedding("mine oak logs near the river")
    v2 = hashed_embedding("collect oak wood by the river")
    v3 = hashed_embedding("fight the ender dragon")
    assert cosine(v1, v2) > cosine(v1, v3)
    assert abs(sum(x * x for x in v1) - 1) < 1e-4
    p = MockProvider("m")
    p.fail_embeddings = True
    router = LLMRouter([p])
    from emeth.llm.embeddings import Embedder

    emb = Embedder(router)
    vec = await emb.embed_one("hello")
    assert len(vec) == len(v1)


class _PaidMock(MockProvider):
    """A mock that bills like a keyed provider."""

    def __init__(self, provider_id: str, cost: float, responses: list | None = None):
        super().__init__(provider_id, responses=responses)
        self.config.api_key_env = "EMETH_TEST_FAKE_KEY"
        self.cost = cost

    async def chat(self, request: ChatRequest):  # type: ignore[no-untyped-def]
        resp = await super().chat(request)
        resp.cost_usd = self.cost
        return resp


async def test_router_spend_cap_blocks_paid_providers_and_persists(tmp_path):
    ledger = tmp_path / "spend.json"
    paid = _PaidMock("paid", 0.6, responses=["a", "b", "c"])
    router = LLMRouter([paid], max_usd=1.0, spend_path=ledger)
    req = ChatRequest(messages=[Message(role="user", content="hi")])
    await router.chat(req)
    await router.chat(req)  # 1.2 USD spent: the call that crossed the cap is honoured, the next one is not
    assert router.budget_exhausted() and router.budget()["spent_usd"] == pytest.approx(1.2)
    with pytest.raises(LLMError, match="spend cap"):
        await router.chat(req)
    # a restart reads the ledger back: the budget is not re-spent
    again = LLMRouter([_PaidMock("paid", 0.6, responses=["d"])], max_usd=1.0, spend_path=ledger)
    assert again.budget_exhausted()
    with pytest.raises(LLMError, match="spend cap"):
        await again.chat(req)


async def test_router_spend_cap_keeps_local_providers():
    paid = _PaidMock("paid", 2.0, responses=["paid answer"])
    local = MockProvider("local", responses=["local answer"])
    router = LLMRouter([paid, local], max_usd=1.0)
    assert (await router.chat(ChatRequest(messages=[Message(role="user", content="1")]))).provider == "paid"
    resp = await router.chat(ChatRequest(messages=[Message(role="user", content="2")]))
    assert resp.provider == "local" and resp.text == "local answer"
    assert router.ledger["local"].cost_usd == 0


async def test_router_unreadable_spend_ledger_fails_closed(tmp_path):
    ledger = tmp_path / "spend.json"
    ledger.write_text("{not json", encoding="utf-8")
    router = LLMRouter([_PaidMock("paid", 0.0, responses=["x"])], max_usd=5.0, spend_path=ledger)
    assert router.budget_exhausted()
    assert not LLMRouter([MockProvider("m")], spend_path=ledger).budget_exhausted()  # no cap → no effect


async def test_anthropic_learns_sampling_and_forced_tool_quirks():
    import httpx

    from emeth.config import ProviderConfig
    from emeth.llm.anthropic import AnthropicProvider

    seen: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        import json as _json

        body = _json.loads(req.content)
        seen.append(body)
        if "temperature" in body:
            return httpx.Response(400, json={"error": {"message": "temperature: only the default value is supported for this model"}})
        if body.get("tool_choice", {}).get("type") in ("any", "tool"):
            return httpx.Response(400, json={"error": {"message": "tool_choice: type \"tool\" and \"any\" are not supported for this model."}})
        return httpx.Response(200, json={"content": [{"type": "tool_use", "id": "t1", "name": "decision", "input": {"ok": True}}], "usage": {"input_tokens": 100, "output_tokens": 10}})

    cfg = ProviderConfig(id="anthropic", api_format="anthropic", base_url="https://api.test", api_key="k", models={"smart": "claude-sonnet-5-5"}, effort="low", input_cost_per_m=2.0, output_cost_per_m=10.0)
    p = AnthropicProvider(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    req = ChatRequest(messages=[Message(role="system", content="sys"), Message(role="user", content="hi")], json_schema={"type": "object"}, json_schema_name="decision", temperature=0.4)
    resp = await p.chat(req)
    assert resp.json_data == {"ok": True}
    assert resp.cost_usd == pytest.approx((100 * 2 + 10 * 10) / 1e6)
    last = seen[-1]
    assert "temperature" not in last and last["tool_choice"] == {"type": "auto"}
    assert last["output_config"] == {"effort": "low"}
    assert "decision" in last["system"][-1]["text"]
    n = len(seen)
    await p.chat(req)  # quirks are remembered: a single request the second time
    assert len(seen) == n + 1


def test_free_args_reads_string_when_object_is_closed():
    from emeth.llm.base import free_args

    assert free_args({"args": {}, "args_json": '{"name": "spruce_planks", "count": 12}'}) == {"name": "spruce_planks", "count": 12}
    assert free_args({"args": {"name": "x"}, "args_json": '{"name": "y"}'}) == {"name": "x"}
    assert free_args({"args_json": "```json\n{\"n\": 1}\n```"}) == {"n": 1}
    assert free_args({"args": {}, "args_json": "not json"}) == {}
    assert free_args({}) == {}


def test_parse_decision_uses_args_json():
    from emeth.cognition.decide import DECISION_SCHEMA, parse_decision
    from emeth.llm.types import ChatResponse

    assert "args_json" in DECISION_SCHEMA["properties"]["action"]["properties"]
    resp = ChatResponse(json_data={"reason": "r", "speech": None, "action": {"type": "primitive", "name": "craft", "args": {}, "args_json": '{"name": "spruce_planks", "count": 12}'}})
    d = parse_decision(resp, {"craft"})
    assert d.ok and d.action_name == "craft" and d.action_args == {"name": "spruce_planks", "count": 12}
