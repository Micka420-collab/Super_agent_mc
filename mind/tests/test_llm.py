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
