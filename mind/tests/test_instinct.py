"""Instinct: the agent keeps living when no language model answers."""

from __future__ import annotations

import asyncio

from emeth.cognition.instinct import InstinctContext, instinct
from emeth.cognition.planner import Planner, Task
from emeth.llm.types import LLMError
from emeth.memory.store import MemoryStore
from emeth.protocol import ItemStack
from tests.fakes import FakeWorld, sample_observation
from tests.test_loop import make_loop, wait_for_action_task

ACTIONS = {"eat", "sleep", "mine", "get", "craft", "wait", "goto"}


_n = 0


def ctx(tmp_path, obs, *, busy=False, skills=frozenset(), milestone: str | None = None) -> InstinctContext:
    global _n
    _n += 1
    planner = Planner(MemoryStore(tmp_path / f"p{_n}.sqlite"))
    if milestone:
        planner.add_goal("ladder", [Task(description=milestone, kind="gather", source=f"curriculum:{milestone}")], source="curriculum")
    return InstinctContext(obs=obs, planner=planner, busy=busy, available_skills=set(skills), known_actions=set(ACTIONS))


def test_instinct_keeps_a_running_body_and_eats_when_hungry(tmp_path):
    obs = sample_observation()
    assert instinct(ctx(tmp_path, obs, busy=True)).action_type == "keep"
    obs.self_.food = 5
    obs.inventory.items = [ItemStack(name="bread", count=2, slot=0), ItemStack(name="cooked_beef", count=1, slot=1)]
    d = instinct(ctx(tmp_path, obs))
    assert d.action_type == "primitive" and d.action_name == "eat" and d.action_args == {"name": "cooked_beef"}


def test_instinct_handles_the_night(tmp_path):
    obs = sample_observation()
    obs.world.phase = "night"
    obs.self_.food = 20
    # nothing to build with and no shelter skill → wait for daylight
    obs.inventory.items = []
    d = instinct(ctx(tmp_path, obs))
    assert d.action_type == "wait" and d.wait_for == "daylight"
    # the shelter skill in the library → run it by name (no code model)
    d = instinct(ctx(tmp_path, obs, skills={"emergency_shelter"}))
    assert d.action_type == "stored_skill" and d.action_name == "emergency_shelter"
    # a bed in hand beats everything
    obs.inventory.items = [ItemStack(name="red_bed", count=1, slot=0)]
    d = instinct(ctx(tmp_path, obs, skills={"emergency_shelter"}))
    assert d.action_name == "sleep" and d.action_args == {"waitForMorning": True}


def test_instinct_follows_the_survival_ladder(tmp_path):
    obs = sample_observation()
    obs.world.phase = "day"
    obs.self_.food = 20
    obs.inventory.items = []
    assert instinct(ctx(tmp_path, obs, milestone="wood")).action_args["name"] == "log"
    d = instinct(ctx(tmp_path, obs, milestone="wood_pickaxe"))
    assert d.action_name == "get" and d.action_args == {"name": "wooden_pickaxe", "count": 1}
    # alternatives already satisfied are skipped: with a stone pickaxe, the axe comes next
    obs.inventory.items = [ItemStack(name="stone_pickaxe", count=1, slot=0)]
    d = instinct(ctx(tmp_path, obs, milestone="stone_tools"))
    assert d.action_args["name"] == "stone_axe"
    # a custom milestone without a skill → rest, with a reason the mind can read later
    d = instinct(ctx(tmp_path, obs, milestone="farm"))
    assert d.action_type == "wait" and "instinct" in d.reason
    d = instinct(ctx(tmp_path, obs, milestone="shelter", skills={"emergency_shelter"}))
    assert d.action_type == "stored_skill"


async def test_loop_falls_back_to_instinct_when_the_llm_is_dead(tmp_path):
    world = FakeWorld()
    world.set_inventory({})
    loop, body, provider = await make_loop(tmp_path, world)
    dead = LLMError("all providers failed: 503", retryable=False)
    provider.script = lambda req: dead  # every call fails, whatever the purpose
    # the loop's own error path: think() raises, act_on_instinct runs the curriculum step deterministically
    try:
        await loop.think("startup")
    except LLMError:
        pass
    decision = await loop.act_on_instinct("startup")
    assert decision.action_type == "primitive" and decision.action_name == "mine" and decision.action_args["name"] == "log"
    await wait_for_action_task(loop)
    assert world.actions[-1][0] == "mine"
    assert loop.stats.instinct_decisions == 1 and loop.stats.decisions == 0
    texts = [e.text for e in loop.timeline.entries]
    assert any(t.startswith("instinct:") for t in texts)
    # the stored-skill path really ships the library's code to the body
    await loop.synthesizer.library.add("emergency_shelter", "async function main(api, args) { return { ok: true }; }", "hut")
    world.observation["world"]["phase"] = "night"
    d2 = await loop.act_on_instinct("night")
    assert d2.action_type == "stored_skill"
    await wait_for_action_task(loop)
    assert world.skill_runs and world.skill_runs[-1]["name"] == "emergency_shelter" and "async function main" in world.skill_runs[-1]["code"]
    await body.close()


async def test_run_loop_survives_a_dead_llm(tmp_path):
    world = FakeWorld()
    world.set_inventory({})
    loop, body, provider = await make_loop(tmp_path, world)
    provider.script = lambda req: LLMError("rate limited", status=429, retryable=True)

    async def stop_soon() -> None:
        for _ in range(100):
            await asyncio.sleep(0.05)
            if world.actions:
                break
        loop.stop()

    await asyncio.gather(loop.run(), stop_soon())
    assert world.actions and world.actions[0][0] == "mine"
    assert loop.stats.errors >= 1 and loop.stats.instinct_decisions >= 1
    await body.close()


def test_instinct_is_silent_and_never_fights(tmp_path):
    obs = sample_observation()
    obs.self_.food = 20
    obs.world.phase = "day"
    for milestone in (None, "wood", "diamond", "bed"):
        d = instinct(ctx(tmp_path, obs, milestone=milestone))
        assert d.speech is None and d.action_name not in {"attack", "flee"}


def test_instinct_trusts_the_measured_enclosure_at_night(tmp_path):
    from emeth.memory.context import render_sensory
    from emeth.protocol import Enclosure

    obs = sample_observation()
    obs.world.phase = "night"
    obs.self_.food = 20
    obs.inventory.items = []
    obs.blocks.enclosure = Enclosure(enclosed=True, cells=2, roofed=True, summary="sealed in: 2 open cells, closed on every side")
    d = instinct(ctx(tmp_path, obs, skills={"emergency_shelter"}))
    assert d.action_type == "wait" and "sealed" in d.reason  # already safe: no second shelter
    assert "Shelter (measured now): sealed in" in render_sensory(obs)
    obs.blocks.enclosure = Enclosure(enclosed=False, cells=160, roofed=False, summary="exposed: open to the outside, monsters can walk or fall to you")
    d = instinct(ctx(tmp_path, obs, skills={"emergency_shelter"}))
    assert d.action_name == "emergency_shelter"  # a shelter that was only believed in does not count
    assert "Shelter (measured now): NONE" in render_sensory(obs)


def test_dawn_reads_as_the_end_of_the_night_and_ends_waits():
    from emeth.cognition.loop import WAIT_BREAKERS
    from emeth.memory.context import render_sensory

    obs = sample_observation()
    obs.world.phase = "dawn"
    obs.world.timeOfDay = 23500
    assert "the night is over" in render_sensory(obs)
    assert "daybreak".startswith(WAIT_BREAKERS) and "nightfall".startswith(WAIT_BREAKERS)
