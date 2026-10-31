"""Instinct — what the agent does when its language mind is unavailable.

API outages, rate limits, an expired key, a laptop that lost Wi-Fi: with most agents the body stands still and the
night takes it. EMETH keeps living. `instinct()` is a small deterministic policy over the same observation, planner
and drives the LLM uses, and it produces the same `Decision` objects, so execution, memory and critic see nothing
special — except that the timeline says *instinct* did it, which the mind reads when it comes back.

Priorities (first match wins):
  -1. dead → respawn (the death screen waits forever otherwise);
  0. the body reads the odds as "flee" → run (even if something is running);
  1. something is already running → keep;
  2. starving with food in hand → eat;
  3. dusk/night outside → sleep in a carried bed, else the `emergency_shelter` skill if the library has it, else wait;
  4. the current curriculum milestone, translated into a deterministic primitive (mostly `get <item>`);
  5. by day, with the ladder steps resting after repeated failures, explore and look for what they lacked;
  6. otherwise wait a while.
A call that already failed the same way three times in a row is not repeated: instinct waits instead (seen live: a
shelter skill retried 894 times in two hours). It never speaks (it has nothing of its own to say) and never fights (reflexes handle defence). A `stored_skill`
decision runs a skill already in the library by name (no code model needed) — only instinct emits that type.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from emeth.cognition.decide import Decision
from emeth.cognition.planner import FOOD_POINTS, Planner, Task
from emeth.cognition.reflection import signature_of
from emeth.protocol import Observation

# milestone id → what to ask the body for (ordered alternatives: the first one not yet satisfied is used)
MILESTONE_ACTIONS: dict[str, list[tuple[str, dict[str, Any], str | None]]] = {
    # (primitive, args, item whose presence satisfies the step — None = always run)
    "wood": [("mine", {"name": "log", "count": 6, "maxDistance": 48}, None)],
    "planks": [("get", {"name": "oak_planks", "count": 12}, "any_planks")],
    "table": [("get", {"name": "crafting_table", "count": 1}, "crafting_table")],
    "sticks": [("get", {"name": "stick", "count": 8}, "stick")],
    "wood_pickaxe": [("get", {"name": "wooden_pickaxe", "count": 1}, "wooden_pickaxe")],
    "stone": [("get", {"name": "cobblestone", "count": 12}, None)],
    "stone_tools": [
        ("get", {"name": "stone_pickaxe", "count": 1}, "stone_pickaxe"),
        ("get", {"name": "stone_axe", "count": 1}, "stone_axe"),
        ("get", {"name": "stone_sword", "count": 1}, "stone_sword"),
    ],
    "food": [("get", {"name": "cooked_beef", "count": 4}, None)],
    "coal": [("get", {"name": "coal", "count": 6}, None)],
    "torches": [("get", {"name": "torch", "count": 8}, None)],
    "furnace": [("get", {"name": "furnace", "count": 1}, "furnace")],
    "iron": [("get", {"name": "iron_ingot", "count": 9}, None)],
    "iron_tools": [
        ("get", {"name": "iron_pickaxe", "count": 1}, "iron_pickaxe"),
        ("get", {"name": "iron_sword", "count": 1}, "iron_sword"),
    ],
    "bed": [("get", {"name": "white_bed", "count": 1}, "white_bed"), ("sleep", {}, None)],
    "iron_armor": [
        ("get", {"name": "iron_chestplate", "count": 1}, "iron_chestplate"),
        ("get", {"name": "iron_leggings", "count": 1}, "iron_leggings"),
    ],
    "diamond": [("get", {"name": "diamond", "count": 3}, None)],
    "diamond_pickaxe": [("get", {"name": "diamond_pickaxe", "count": 1}, "diamond_pickaxe")],
}

# milestones with a `custom` verifier: a seed skill does the job when present
MILESTONE_SKILLS: dict[str, str] = {"shelter": "emergency_shelter"}

SHELTER_SKILL = "emergency_shelter"

# what a resting milestone was missing, for `explore` to stop at (seen live: food failed with no animal in reach)
LOOK_FOR: dict[str, list[str]] = {
    "food": ["cow", "pig", "sheep", "chicken", "rabbit"],
    "iron": ["iron_ore", "deepslate_iron_ore"],
    "coal": ["coal_ore"],
    "diamond": ["diamond_ore", "deepslate_diamond_ore"],
    "bed": ["sheep"],
    "shelter": ["dirt", "stone"],
}
EXPLORE_SECONDS = 60


@dataclass
class InstinctContext:
    obs: Observation
    planner: Planner
    busy: bool
    available_skills: set[str]
    known_actions: set[str]
    # Reflection.same_failure_streak(): (signature, error code, n) of the call that keeps failing, if any
    failure_streak: tuple[str, str, int] | None = None

# failing the same way this many times in a row makes instinct stop retrying that call
GIVE_UP_AFTER = 3


def _count(inv: dict[str, int], name: str) -> int:
    if name == "any_planks":
        return sum(c for n, c in inv.items() if n.endswith("_planks"))
    if name == "any_log":
        return sum(c for n, c in inv.items() if n.endswith("_log"))
    return inv.get(name, 0)


def _best_food(inv: dict[str, int]) -> str | None:
    edible = [(FOOD_POINTS[n], n) for n in inv if n in FOOD_POINTS and inv[n] > 0]
    return max(edible)[1] if edible else None


def _has_bed(inv: dict[str, int]) -> bool:
    return any(n.endswith("_bed") for n in inv)


def _milestone_id(task: Task | None) -> str | None:
    if task is None or not task.source.startswith("curriculum:"):
        return None
    return task.source.split(":", 1)[1]


def instinct(ctx: InstinctContext) -> Decision:
    """A deterministic decision from the current state. Always valid against `known_actions`."""
    if ctx.obs.self_.health <= 0 and "respawn" in ctx.known_actions:
        return Decision(reason="instinct: I am dead, getting back up", action_type="primitive", action_name="respawn", action_args={})
    decision = _choose(ctx)
    streak = ctx.failure_streak
    if streak and streak[2] >= GIVE_UP_AFTER and decision.action_type in ("primitive", "stored_skill") and decision.action_name:
        kind = "primitive" if decision.action_type == "primitive" else "stored_skill"
        if signature_of(kind, decision.action_name, decision.action_args) == streak[0]:
            return Decision(reason=f"instinct: {decision.action_name} failed {streak[2]} times in a row ({streak[1]}), not trying it again now", action_type="wait", wait_seconds=120, wait_for="something to change")
    return decision


def _choose(ctx: InstinctContext) -> Decision:
    obs = ctx.obs
    inv = obs.inventory.summary()
    s = obs.self_
    can = ctx.known_actions.__contains__

    threat = obs.entities.threat
    reflex_running = obs.action is not None and obs.action.name.startswith("reflex:")
    if threat is not None and threat.recommendation == "flee" and threat.nearest and can("flee") and not reflex_running:
        # the reflex layer runs first; this covers the gap when the mind is woken by the threat before the reflex fires
        return Decision(reason=f"instinct: the odds are bad ({', '.join(threat.reasons[:3])}), getting away", action_type="primitive", action_name="flee", action_args={"distance": 24})

    if ctx.busy or obs.action is not None:
        return Decision(reason="instinct: my body is busy, letting it finish", action_type="keep")

    food = _best_food(inv)
    if s.food <= 8 and food and can("eat"):
        return Decision(reason=f"instinct: hungry ({s.food}/20), eating {food}", action_type="primitive", action_name="eat", action_args={"name": food})

    if obs.world.phase in ("dusk", "night") and not s.isSleeping:
        if _has_bed(inv) and can("sleep"):
            return Decision(reason="instinct: night is falling and I carry a bed", action_type="primitive", action_name="sleep", action_args={"waitForMorning": True})
        enc = obs.blocks.enclosure
        if enc is not None and enc.enclosed:
            return Decision(reason=f"instinct: night, and I am {enc.summary} — waiting for daylight here", action_type="wait", wait_seconds=60, wait_for="daylight")
        if SHELTER_SKILL in ctx.available_skills:
            return Decision(reason="instinct: night outside, raising an emergency shelter", action_type="stored_skill", action_name=SHELTER_SKILL, action_args={})
        return Decision(reason="instinct: night outside and nothing to build with, staying put", action_type="wait", wait_seconds=60, wait_for="daylight")

    task = ctx.planner.current_task()
    wounded_near_threat = s.health <= 10 and threat is not None and threat.nearest is not None
    if task is not None and task.target and can("goto") and can("collect_items") and not wounded_near_threat:
        # going back for dropped items before anything else: they despawn in five minutes (seen live: it crafted a
        # pickaxe first and let its things vanish) — but not wounded into whatever killed it (seen live: 7 HP, skeleton)
        x, y, z = task.target
        p = s.position
        if (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 > 9:
            return Decision(reason=f"instinct: {task.description[:60]}", action_type="primitive", action_name="goto", action_args={"x": x, "y": y, "z": z, "range": 2})
        return Decision(reason="instinct: back where I died, picking up my things", action_type="primitive", action_name="collect_items", action_args={"radius": 8})

    had_one = "wood_pickaxe" in ctx.planner.done_milestones  # a newborn follows its ladder instead
    if had_one and not any(n.endswith("_pickaxe") for n in inv) and can("get"):
        # a worn-out pickaxe is replaced before anything else that touches stone (seen live: stone broken by hand)
        stone = sum(inv.get(n, 0) for n in ("cobblestone", "cobbled_deepslate", "blackstone"))
        target = "stone_pickaxe" if stone >= 3 else "wooden_pickaxe"
        return Decision(reason=f"instinct: no pickaxe left, making a {target} before anything else", action_type="primitive", action_name="get", action_args={"name": target, "count": 1})
    if "stone_tools" in ctx.planner.done_milestones and not any(n.endswith("_sword") for n in inv) and can("get"):
        # lost with the rest at a death: every threat reading said "bare hands" and skeletons won (seen live)
        stone = sum(inv.get(n, 0) for n in ("cobblestone", "cobbled_deepslate", "blackstone"))
        target = "stone_sword" if stone >= 1 else "wooden_sword"
        return Decision(reason=f"instinct: no weapon left, making a {target}", action_type="primitive", action_name="get", action_args={"name": target, "count": 1})

    mid = _milestone_id(task)
    if mid:
        for primitive, args, satisfied_by in MILESTONE_ACTIONS.get(mid, []):
            if satisfied_by and _count(inv, satisfied_by) >= int(args.get("count", 1)):
                continue
            if can(primitive):
                return Decision(reason=f"instinct: working on the ladder step '{mid}'", action_type="primitive", action_name=primitive, action_args=dict(args))
        skill = MILESTONE_SKILLS.get(mid)
        if skill and skill in ctx.available_skills:
            return Decision(reason=f"instinct: ladder step '{mid}' through the {skill} skill", action_type="stored_skill", action_name=skill, action_args={})

    resting = ctx.planner.resting_milestones()
    # a task instinct cannot translate (an idea of the language mind) must not freeze it either
    if resting and obs.world.phase not in ("dusk", "night") and can("explore"):
        look = list(dict.fromkeys(name for mid in resting for name in LOOK_FOR.get(mid, [])))
        return Decision(reason=f"instinct: {', '.join(resting)} failed too often for now — exploring for {', '.join(look[:4]) or 'new ground'}", action_type="primitive", action_name="explore", action_args={"direction": "random", "maxSeconds": EXPLORE_SECONDS, "lookFor": look})

    return Decision(reason="instinct: nothing urgent and no language mind — resting", action_type="wait", wait_seconds=45, wait_for="my mind to come back")
