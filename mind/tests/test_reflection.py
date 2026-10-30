"""Reflection: the agent notices it is going in circles, and says what to do instead."""

from __future__ import annotations

import asyncio

from emeth.bridge.client import BodyEvent
from emeth.cognition.instinct import InstinctContext, instinct
from emeth.cognition.planner import Planner, Task
from emeth.cognition.reflection import Reflection, signature_of
from emeth.memory.context import render_entities
from emeth.memory.store import MemoryStore
from emeth.protocol import ThreatState
from tests.fakes import FakeWorld, sample_observation
from tests.test_loop import make_loop, wait_for_action_task


def test_signatures_are_stable_and_literal():
    assert signature_of("primitive", "mine", {"count": 3, "name": "diamond_ore"}) == signature_of("primitive", "mine", {"name": "diamond_ore", "count": 3})
    assert signature_of("primitive", "mine", {"name": "iron_ore"}) != signature_of("primitive", "mine", {"name": "diamond_ore"})
    assert signature_of("skill", None, goal="collect 6 logs") == "skill: collect 6 logs"


def test_same_call_failing_twice_is_named_with_an_alternative():
    r = Reflection()
    sig = signature_of("primitive", "mine", {"name": "diamond_ore", "count": 3})
    r.record(sig, False, "NOT_FOUND", "no diamond_ore within 48 blocks")
    assert r.render() == ""  # once is bad luck
    r.record(sig, False, "NOT_FOUND", "no diamond_ore within 48 blocks")
    text = r.render()
    assert "2 times in a row" in text and "NOT_FOUND" in text
    assert "descend" in text  # the alternative for NOT_FOUND on an ore
    assert r.same_failure_streak() == (sig, "NOT_FOUND", 2)
    assert not r.stuck()
    r.record(sig, False, "NOT_FOUND")
    assert r.stuck()
    # a success clears the streak
    r.record(sig, True)
    assert r.render() == ""
    assert r.same_failure_streak() is None


def test_different_calls_same_code_and_nagging():
    r = Reflection()
    r.record("goto(a)", False, "NO_PATH")
    r.record("goto(b)", False, "NO_PATH")
    assert r.render() == ""
    r.record("goto_entity(c)", False, "NO_PATH")
    first = r.render()
    assert "3 attempts all failed with NO_PATH" in first and "another way" in first
    assert "did not change course" not in first
    second = r.render()  # shown again, unchanged behaviour → escalate
    assert "did not change course" in second and "abandon" in second


def test_rejected_decisions_cool_the_model_and_ask_for_plain_answers():
    r = Reflection()
    assert r.temperature(0.5) == 0.5
    r.decision_rejected(["unknown primitive 'teleport'"])
    assert r.temperature(0.5) == 0.35
    r.decision_rejected(["response was not a JSON object"])
    assert r.temperature(0.5) == 0.2
    text = r.render()
    assert "2 thoughts were rejected" in text and "teleport" not in text and "JSON" in text
    r.decision_accepted()
    assert r.render() == "" and r.temperature(0.5) == 0.5
    task = Task(description="Mine 12 cobblestone", attempts=2, last_error="missing 7 cobblestone")
    assert "attempt 3 of 4" in r.render(task)


def test_threat_reaches_the_prompt_the_drives_and_the_instinct(tmp_path):
    obs = sample_observation()
    obs.entities.threat = ThreatState(danger=0.9, recommendation="flee", reasons=["zombie 3m", "zombie 4m", "no armor"], count=2, nearest={"name": "zombie", "distance": 3})
    text = render_entities(obs)
    assert "Odds: danger 90% → flee (zombie 3m, zombie 4m, no armor)" in text
    planner = Planner(MemoryStore(tmp_path / "p.sqlite"))
    d = instinct(InstinctContext(obs=obs, planner=planner, busy=True, available_skills=set(), known_actions={"flee", "eat", "wait"}))
    assert d.action_type == "primitive" and d.action_name == "flee"
    # without the flee primitive the body stays with what it was doing
    d2 = instinct(InstinctContext(obs=obs, planner=planner, busy=True, available_skills=set(), known_actions={"eat", "wait"}))
    assert d2.action_type == "keep"


async def test_loop_reflects_on_repeated_failures_and_learns_where_home_is(tmp_path):
    world = FakeWorld()
    world.action_handler = lambda name, args, w: {"__error__": "no diamond_ore within 48 blocks", "code": "NOT_FOUND"} if name == "mine" else {"done": True}
    loop, body, provider = await make_loop(tmp_path, world, synth=False)
    seen: list[str] = []
    orig = provider.script

    def brain(request):
        if request.purpose == "decision":
            seen.append(request.messages[-1].content)
            if "[REFLECTION]" in request.messages[-1].content:
                return {"reason": "I keep failing, digging down instead", "speech": None, "action": {"type": "primitive", "name": "wait", "args": {"seconds": 1}}}
            return {"reason": "diamonds!", "speech": None, "action": {"type": "primitive", "name": "mine", "args": {"name": "diamond_ore", "count": 3}}}
        return orig(request)

    provider.script = brain
    for _ in range(2):
        await loop.think("test")
        await wait_for_action_task(loop)
    assert loop.reflection.same_failure_streak() is not None
    assert "[REFLECTION]" not in seen[0]
    await loop.think("test")
    assert "[REFLECTION]" in seen[-1]
    assert "2 times in a row" in seen[-1] and "NOT_FOUND" in seen[-1]
    assert seen[-1].count("descend") >= 1
    assert loop.snapshot()["reflection"]["same_failure"][2] == 2
    # the decision temperature follows the reflection (no rejected decisions here → unchanged)
    assert loop.reflection.temperature(0.5) == 0.5

    # sleeping marks the bed as home and satisfies the `bed` milestone's verifier
    loop._handle_event(BodyEvent(event="sleep", ts=0, payload={"timeOfDay": 13000, "day": 2}))  # noqa: SLF001
    await asyncio.sleep(0.3)
    assert loop.planner.flags.get("slept") is True
    homes = loop.graph.nearest(0, 64, 0, kind="place", label="home", limit=1)
    assert homes and homes[0][0].label == "home"
    obs = sample_observation()
    obs.self_.position.x += 300
    obs.world.phase = "day"
    obs.world.timeOfDay = 10800  # one minute before dusk
    advice = loop.home_advice(obs)
    assert "Home is at" in advice and "head back now" in advice
    obs.world.phase = "night"
    assert "far from your bed" in loop.home_advice(obs)
    await body.close()


def test_custom_milestones_become_flags_when_their_task_completes(tmp_path):
    planner = Planner(MemoryStore(tmp_path / "p.sqlite"))
    task = Task(description="Build a lit shelter", kind="build", success={"custom": "shelter"}, source="curriculum:shelter")
    planner.add_goal("shelter", [task], source="curriculum")
    planner.complete_task(task)
    assert planner.flags["custom:shelter"] is True
    planner.mark_slept()
    reloaded = Planner(MemoryStore(tmp_path / "p.sqlite"))
    assert reloaded.flags == {"custom:shelter": True, "slept": True}
