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
    # advice from the owner (plugin, dashboard, MCP) promises to wake the next thought: a wait must not swallow it
    assert "mentor:plugin".startswith(WAIT_BREAKERS) and "player joined: Micka".startswith(WAIT_BREAKERS)


def test_instinct_replaces_a_lost_pickaxe_first(tmp_path):
    obs = sample_observation()
    obs.world.phase = "day"
    obs.self_.food = 20
    obs.inventory.items = [ItemStack(name="cobblestone", count=64, slot=0), ItemStack(name="stick", count=2, slot=1)]
    c = ctx(tmp_path, obs)
    c.planner.done_milestones.add("wood_pickaxe")  # it had one: this is a worn-out pickaxe, not a newborn
    d = instinct(c)
    assert d.action_name == "get" and d.action_args == {"name": "stone_pickaxe", "count": 1}
    obs.inventory.items = [ItemStack(name="stone_pickaxe", count=1, slot=0)]
    assert instinct(c).action_args.get("name") != "stone_pickaxe"


def test_tool_wear_and_missing_pickaxe_are_in_the_context():
    from emeth.memory.context import render_inventory

    obs = sample_observation()
    obs.self_.heldItem = None
    obs.inventory.items = [ItemStack(name="stone_pickaxe", count=1, slot=0, durability=9, maxDurability=131)]
    assert "almost worn out (9 uses left)" in render_inventory(obs)
    obs.inventory.items = [ItemStack(name="cobblestone", count=64, slot=0), ItemStack(name="stick", count=2, slot=1)]
    text = render_inventory(obs)
    assert "NO PICKAXE" in text and "you carry what a stone_pickaxe needs" in text and "`get stone_pickaxe`" in text


def test_instinct_respawns_a_dead_body_first(tmp_path):
    obs = sample_observation()
    obs.self_.health = 0
    c = ctx(tmp_path, obs, busy=True)  # a reflex that outlived the death still holds the hands
    c.known_actions.add("respawn")
    d = instinct(c)
    assert d.action_type == "primitive" and d.action_name == "respawn"


def test_instinct_stops_repeating_a_call_that_keeps_failing(tmp_path):
    obs = sample_observation()
    obs.world.phase = "night"
    obs.blocks.enclosure = None
    c = ctx(tmp_path, obs, skills={"emergency_shelter"})
    assert instinct(c).action_name == "emergency_shelter"
    c.failure_streak = ("stored_skill: emergency_shelter", "NOT_FOUND", 3)
    d = instinct(c)
    assert d.action_type == "wait" and "3 times" in d.reason
    # another call failing does not block this one
    c.failure_streak = ("primitive: get", "NOT_FOUND", 5)
    assert instinct(c).action_name == "emergency_shelter"


def test_instinct_leaves_a_running_flee_reflex_alone(tmp_path):
    from emeth.protocol import CurrentAction, ThreatState

    obs = sample_observation()
    obs.entities.threat = ThreatState.model_validate({"danger": 0.9, "recommendation": "flee", "reasons": ["creeper 8m"], "nearest": {"name": "creeper", "distance": 8}})
    obs.action = CurrentAction(id="r1", name="reflex:flee", startedAt=0)
    c = ctx(tmp_path, obs)
    c.known_actions.add("flee")
    assert instinct(c).action_type == "keep"


def test_a_failed_milestone_rests_then_comes_back(tmp_path):
    # seen live: food, shelter and iron failed three times each and the whole ladder stood still for eight hours
    planner = Planner(MemoryStore(tmp_path / "rest.sqlite"))
    planner.done_milestones |= {"wood", "planks", "table", "sticks", "wood_pickaxe", "stone", "stone_tools", "coal", "torches", "furnace"}
    for _ in range(3):
        planner.record_milestone_failure(Task(description="food", source="curriculum:food"))
    t0 = planner.failed_at["food"]
    assert planner.resting("food", t0 + 60)
    nxt = planner.next_milestone(t0 + 60)
    assert nxt is not None and nxt[0] != "food"
    assert planner.next_milestone(t0 + 20 * 60 + 1)[0] == "food"
    # one more failure doubles the rest, and it survives a restart
    planner.record_milestone_failure(Task(description="food", source="curriculum:food"))
    again = Planner(MemoryStore(tmp_path / "rest.sqlite"))
    t1 = again.failed_at["food"]
    assert again.resting("food", t1 + 39 * 60) and not again.resting("food", t1 + 41 * 60)
    # a count saved before failure times existed does not lock the step forever
    again.failed_at.pop("iron", None)
    again.failed_milestones["iron"] = 3
    assert not again.resting("iron")


def test_instinct_explores_for_what_resting_steps_lacked(tmp_path):
    obs = sample_observation()
    obs.world.phase = "day"
    obs.self_.food = 20
    obs.inventory.items = [ItemStack(name="stone_pickaxe", count=1, slot=0)]
    c = ctx(tmp_path, obs)
    c.known_actions.add("explore")
    for mid in ("food", "iron"):
        for _ in range(3):
            c.planner.record_milestone_failure(Task(description=mid, source=f"curriculum:{mid}"))
    c.planner.done_milestones |= {"wood", "planks", "table", "sticks", "wood_pickaxe", "stone", "stone_tools", "coal", "torches", "furnace", "shelter"}
    c.planner.failed_milestones["shelter"] = 0
    assert c.planner.current_task() is None
    d = instinct(c)
    assert d.action_type == "primitive" and d.action_name == "explore", d
    assert "cow" in d.action_args["lookFor"] and "iron_ore" in d.action_args["lookFor"]
    # never at night
    obs.world.phase = "night"
    assert instinct(c).action_name != "explore"
