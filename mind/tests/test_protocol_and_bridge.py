import asyncio

import pytest

from emeth.bridge.client import BodyClient
from emeth.protocol import ActionResult, BodyError, HelloResult, Observation, SkillRunResult
from tests.fakes import FakeWorld, fake_transport_factory, load_fixture


def test_fixtures_validate_against_pydantic_models():
    obs = Observation.model_validate(load_fixture("observation.json"))
    assert obs.self_.username == "Emeth"
    assert obs.entities.hostiles[0].name == "zombie"
    assert obs.inventory.count("bread") == 3
    hello = HelloResult.model_validate(load_fixture("hello.json"))
    assert len(hello.actions) >= 40
    assert "api.mine" in hello.skillApiDoc
    ok = ActionResult.model_validate(load_fixture("action-result.json"))
    assert ok.ok and ok.result["mined"] == 3
    bad = ActionResult.model_validate(load_fixture("action-failure.json"))
    assert bad.errorCode == "MISSING_ITEM"
    skill = SkillRunResult.model_validate(load_fixture("skill-result.json"))
    assert skill.trace[-1].ok is False
    env = load_fixture("envelopes.json")
    assert env["request"]["kind"] == "request"


async def test_body_client_round_trip_and_events():
    world = FakeWorld()
    client = BodyClient(fake_transport_factory(world))
    await client.connect()
    assert client.hello is not None and "goto" in client.action_names
    obs = await client.observe()
    assert obs.world.day == 3
    res = await client.act("say", {"text": "hello"})
    assert res.ok and world.actions == [("say", {"text": "hello"})]
    await client.chat("yo", to="Steve")
    assert world.chats == [("yo", "Steve")]
    with pytest.raises(BodyError) as exc:
        await client.act("teleport", {})
    assert exc.value.code == "UNKNOWN_ACTION"
    transport = fake_transport_factory.__wrapped__ if hasattr(fake_transport_factory, "__wrapped__") else None  # noqa: F841
    # events flow into the queue; observations update latest_observation without queueing
    t = client._transport  # type: ignore[attr-defined]
    await t.emit("chat", {"from": "Steve", "text": "hi"})  # type: ignore[attr-defined]
    await t.emit("observation", world.observation)  # type: ignore[attr-defined]
    ev = await asyncio.wait_for(client.events.get(), 2)
    assert ev.event == "chat" and ev.payload["from"] == "Steve"
    await asyncio.sleep(0.05)
    assert client.latest_observation is not None
    assert client.events.empty()
    await client.close()


def test_a_program_that_reports_its_own_failure_did_not_succeed():
    from emeth.bridge.client import judge_skill_result
    from emeth.protocol import SkillRunResult

    base = {"id": "1", "name": "shelter", "logs": [], "trace": [], "startedAt": 0, "finishedAt": 1}
    bad = judge_skill_result(SkillRunResult.model_validate({**base, "ok": True, "result": {"sealed": False, "placed": 3}}))
    assert not bad.ok and bad.errorCode == "SELF_REPORTED_FAILURE" and "sealed=false" in (bad.error or "")
    good = judge_skill_result(SkillRunResult.model_validate({**base, "ok": True, "result": {"sealed": True}}))
    assert good.ok
    plain = judge_skill_result(SkillRunResult.model_validate({**base, "ok": True, "result": 12}))
    assert plain.ok
