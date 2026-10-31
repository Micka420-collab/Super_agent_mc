"""Goals & planning — a persistent goal stack plus a deterministic survival curriculum.

The curriculum (Voyager's idea, made deterministic and verifiable) is a ladder of milestones with
programmatic success checks on the inventory/world. The LLM can propose *novel* tasks on top, but
the ladder guarantees steady progress even with a weak model, and the critic can always verify.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal

from emeth.memory.store import MemoryStore
from emeth.protocol import Observation

GoalStatus = Literal["active", "paused", "done", "failed", "abandoned"]


@dataclass
class Task:
    description: str
    kind: Literal["gather", "craft", "build", "explore", "survive", "social", "custom"] = "custom"
    success: dict[str, Any] = field(default_factory=dict)  # verifier spec, e.g. {"inventory": {"oak_log": 4}}
    attempts: int = 0
    max_attempts: int = 4
    status: GoalStatus = "active"
    created_at: float = field(default_factory=time.time)
    last_error: str = ""
    source: str = "curriculum"  # curriculum | llm | player | self
    target: list[float] | None = None  # a place the task is about (x, y, z), e.g. where the agent died

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Task:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Goal:
    title: str
    why: str = ""
    tasks: list[Task] = field(default_factory=list)
    status: GoalStatus = "active"
    priority: int = 5  # 1 (urgent) .. 9 (someday)
    source: str = "self"
    created_at: float = field(default_factory=time.time)
    expires_at: float | None = None  # past this time the goal no longer makes sense (dropped items despawn)

    def current_task(self) -> Task | None:
        for t in self.tasks:
            if t.status == "active":
                return t
        return None

    def to_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["tasks"] = [t.to_dict() for t in self.tasks]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Goal:
        tasks = [Task.from_dict(t) for t in d.get("tasks", [])]
        return cls(title=d["title"], why=d.get("why", ""), tasks=tasks, status=d.get("status", "active"), priority=d.get("priority", 5), source=d.get("source", "self"), created_at=d.get("created_at", time.time()), expires_at=d.get("expires_at"))


# --- Survival curriculum ladder -----------------------------------------------------------------
# Each milestone: (id, description, kind, success spec, prerequisite ids)
# Success spec keys: inventory {item: count}  |  inventory_any [[item, count], ...]  |  tool_tier "stone"  |  armor_pieces n | custom
LADDER: list[tuple[str, str, str, dict[str, Any], list[str]]] = [
    ("wood", "Punch a tree and collect 6 logs", "gather", {"inventory_any": [["oak_log", 6], ["birch_log", 6], ["spruce_log", 6], ["jungle_log", 6], ["acacia_log", 6], ["dark_oak_log", 6], ["mangrove_log", 6], ["cherry_log", 6], ["any_log", 6]]}, []),
    ("planks", "Craft 12 planks", "craft", {"inventory_any": [["any_planks", 12]]}, ["wood"]),
    ("table", "Craft a crafting table", "craft", {"inventory_any": [["crafting_table", 1], ["placed:crafting_table", 1]]}, ["planks"]),
    ("sticks", "Craft 8 sticks", "craft", {"inventory": {"stick": 8}}, ["planks"]),
    ("wood_pickaxe", "Craft a wooden pickaxe", "craft", {"tool_tier": "wooden"}, ["table", "sticks"]),
    ("stone", "Mine 12 cobblestone", "gather", {"inventory_any": [["cobblestone", 12], ["cobbled_deepslate", 12]]}, ["wood_pickaxe"]),
    ("stone_tools", "Craft a stone pickaxe, axe and sword", "craft", {"inventory": {"stone_pickaxe": 1, "stone_axe": 1, "stone_sword": 1}}, ["stone"]),
    ("food", "Get 8 portions of food (meat, bread, apples...)", "gather", {"food_points": 32}, ["stone_tools"]),
    ("coal", "Mine 6 coal (or make charcoal)", "gather", {"inventory_any": [["coal", 6], ["charcoal", 6]]}, ["stone_tools"]),
    ("torches", "Craft 8 torches", "craft", {"inventory": {"torch": 8}}, ["coal", "sticks"]),
    ("shelter", "Build a lit shelter with a door and a bed before night", "build", {"custom": "shelter"}, ["stone_tools", "torches"]),
    ("furnace", "Craft and place a furnace", "craft", {"inventory_any": [["furnace", 1], ["placed:furnace", 1]]}, ["stone"]),
    ("iron", "Mine 9 iron ore and smelt it into iron ingots", "gather", {"inventory_any": [["iron_ingot", 9], ["raw_iron", 9]]}, ["furnace", "stone_tools"]),
    ("iron_tools", "Craft an iron pickaxe and an iron sword", "craft", {"tool_tier": "iron"}, ["iron"]),
    ("bed", "Sleep in a bed (3 wool + 3 planks)", "survive", {"slept": 1}, ["shelter"]),
    ("iron_armor", "Wear at least 2 pieces of iron armor", "craft", {"armor_pieces": 2}, ["iron_tools"]),
    ("farm", "Start a wheat farm (till soil, plant seeds, water nearby)", "build", {"custom": "farm"}, ["shelter", "iron_tools"]),
    ("diamond", "Find and mine 3 diamonds", "gather", {"inventory": {"diamond": 3}}, ["iron_tools", "torches"]),
    ("diamond_pickaxe", "Craft a diamond pickaxe", "craft", {"tool_tier": "diamond"}, ["diamond"]),
    ("enchant", "Build an enchanting table", "craft", {"inventory_any": [["enchanting_table", 1], ["placed:enchanting_table", 1]]}, ["diamond_pickaxe"]),
    ("nether", "Build a nether portal and light it", "build", {"custom": "portal"}, ["diamond_pickaxe"]),
]

# a milestone that failed GIVE_UP_AFTER times rests, then comes back: 20 min, 40 min, 80 min… capped at 4 h. Banning it
# for good locked the whole ladder (seen live: food, shelter and iron failed three times each, every later step needed
# one of them, and the agent stood still for eight hours)
GIVE_UP_AFTER = 3
RETRY_AFTER_S = 20 * 60
RETRY_MAX_S = 4 * 3600


RECOVER_PREFIX = "Recover my belongings"
DROP_LIFETIME_S = 5 * 60  # items on the ground despawn after 6000 ticks


def retry_delay(failures: int) -> float:
    return min(RETRY_MAX_S, RETRY_AFTER_S * 2 ** max(0, failures - GIVE_UP_AFTER))


TOOL_TIERS = ["wooden", "stone", "iron", "diamond", "netherite"]
FOOD_POINTS = {"cooked_beef": 8, "cooked_porkchop": 8, "cooked_mutton": 6, "cooked_chicken": 6, "cooked_cod": 5, "cooked_salmon": 6, "bread": 5, "apple": 4, "baked_potato": 5, "carrot": 3, "golden_apple": 4, "melon_slice": 2, "cooked_rabbit": 5, "beef": 3, "porkchop": 3, "chicken": 2, "mutton": 2, "potato": 1, "sweet_berries": 2, "glow_berries": 2, "pumpkin_pie": 8, "mushroom_stew": 6, "rabbit_stew": 10, "beetroot_soup": 6, "dried_kelp": 1}


def tool_tier_index(name: str) -> int:
    prefix = name.split("_")[0]
    return TOOL_TIERS.index(prefix) if prefix in TOOL_TIERS else -1


def check_success(spec: dict[str, Any], obs: Observation, state: dict[str, Any] | None = None) -> tuple[bool, str]:
    """Programmatic verifier shared by the curriculum and the critic."""
    inv = obs.inventory.summary()
    state = state or {}

    def count_any(name: str) -> int:
        if name == "any_log":
            return sum(c for n, c in inv.items() if n.endswith("_log"))
        if name == "any_planks":
            return sum(c for n, c in inv.items() if n.endswith("_planks"))
        if name.startswith("placed:"):
            block = name.split(":", 1)[1]
            return sum(1 for b in obs.blocks.notable if b.name == block) + int(obs.blocks.nearbyCounts.get(block, 0))
        return inv.get(name, 0)

    if "inventory" in spec:
        missing = {k: v - count_any(k) for k, v in spec["inventory"].items() if count_any(k) < v}
        return (not missing, "missing " + ", ".join(f"{v} {k}" for k, v in missing.items()) if missing else "all items present")
    if "inventory_any" in spec:
        for name, count in spec["inventory_any"]:
            if count_any(name) >= count:
                return True, f"have {count_any(name)} {name}"
        best = max(spec["inventory_any"], key=lambda nc: count_any(nc[0]))
        return False, f"best progress: {count_any(best[0])}/{best[1]} {best[0]}"
    if "tool_tier" in spec:
        want = TOOL_TIERS.index(spec["tool_tier"])
        picks = [n for n in inv if n.endswith("_pickaxe") and tool_tier_index(n) >= want]
        if spec["tool_tier"] == "wooden":
            return (bool(picks), "pickaxe found" if picks else "no pickaxe")
        swords = [n for n in inv if n.endswith("_sword") and tool_tier_index(n) >= want]
        ok = bool(picks) and (bool(swords) or spec["tool_tier"] == "diamond")
        return ok, f"pickaxe={bool(picks)} sword={bool(swords)}"
    if "food_points" in spec:
        pts = sum(FOOD_POINTS.get(n, 0) * c for n, c in inv.items())
        return pts >= spec["food_points"], f"{pts}/{spec['food_points']} food points"
    if "armor_pieces" in spec:
        pieces = sum(1 for v in obs.self_.armor.values() if v)
        return pieces >= spec["armor_pieces"], f"{pieces} armor pieces worn"
    if "slept" in spec:
        return bool(state.get("slept")), "slept" if state.get("slept") else "not slept yet"
    if "custom" in spec:
        key = spec["custom"]
        return bool(state.get(f"custom:{key}")), f"custom milestone {key}: {'done' if state.get(f'custom:{key}') else 'pending'}"
    return False, "unknown success spec"


class Planner:
    """Owns the goal stack and the curriculum cursor; persisted in the store."""

    def __init__(self, store: MemoryStore):
        self.store = store
        self.goals: list[Goal] = [Goal.from_dict(g) for g in store.get("goals", [])]
        self.done_milestones: set[str] = set(store.get("milestones.done", []))
        self.failed_milestones: dict[str, int] = dict(store.get("milestones.failed", {}))
        # when each milestone last failed; a count without a time (older state) is eligible again at once
        self.failed_at: dict[str, float] = dict(store.get("milestones.failed_at", {}))
        self.flags: dict[str, Any] = dict(store.get("planner.flags", {}))
        for g in self.goals:
            # saved before goals could expire: a recovery goal is only worth the five minutes the drops last
            if g.expires_at is None and g.title.startswith(RECOVER_PREFIX):
                g.expires_at = g.created_at + DROP_LIFETIME_S

    def save(self) -> None:
        self.store.set("goals", [g.to_dict() for g in self.goals])
        self.store.set("milestones.done", sorted(self.done_milestones))
        self.store.set("milestones.failed", self.failed_milestones)
        self.store.set("milestones.failed_at", self.failed_at)
        self.store.set("planner.flags", self.flags)

    # ---- goal stack ------------------------------------------------------------------------
    def expire_goals(self, now: float | None = None) -> list[Goal]:
        """Abandon the goals whose deadline has passed (seen live: an old recovery goal held the stack for six hours)."""
        now = now if now is not None else time.time()
        gone = [g for g in self.goals if g.status == "active" and g.expires_at is not None and now >= g.expires_at]
        for g in gone:
            g.status = "abandoned"
        if gone:
            self.save()
        return gone

    def active_goal(self) -> Goal | None:
        self.expire_goals()
        active = [g for g in self.goals if g.status == "active"]
        active.sort(key=lambda g: (g.priority, g.created_at))
        return active[0] if active else None

    def current_task(self) -> Task | None:
        g = self.active_goal()
        return g.current_task() if g else None

    def add_goal(self, title: str, tasks: list[Task], *, why: str = "", priority: int = 5, source: str = "self") -> Goal:
        goal = Goal(title=title, why=why, tasks=tasks, priority=priority, source=source)
        self.goals.append(goal)
        self.goals = self.goals[-30:]
        self.save()
        return goal

    def complete_task(self, task: Task) -> None:
        task.status = "done"
        # a verified custom milestone (shelter, farm, portal) becomes a durable fact the ladder can see
        custom = task.success.get("custom") if task.success else None
        if custom:
            self.flags[f"custom:{custom}"] = True
        for g in self.goals:
            if g.status == "active" and all(t.status in ("done", "abandoned") for t in g.tasks):
                g.status = "done"
        self.save()

    def mark_slept(self) -> None:
        """The body slept in a bed: the `bed` milestone's verifier reads this flag."""
        if not self.flags.get("slept"):
            self.flags["slept"] = True
            self.save()

    def fail_task(self, task: Task, error: str) -> None:
        task.attempts += 1
        task.last_error = error[:300]
        if task.attempts >= task.max_attempts:
            task.status = "failed"
            for g in self.goals:
                if task in g.tasks and all(t.status in ("done", "failed", "abandoned") for t in g.tasks):
                    g.status = "failed"
        self.save()

    def abandon_goal(self, title: str) -> bool:
        for g in self.goals:
            if g.title == title and g.status == "active":
                g.status = "abandoned"
                self.save()
                return True
        return False

    # ---- curriculum ------------------------------------------------------------------------
    def refresh_milestones(self, obs: Observation) -> list[str]:
        """Mark ladder milestones satisfied by the current state. Returns newly completed ids."""
        newly: list[str] = []
        for mid, _desc, _kind, spec, _pre in LADDER:
            if mid in self.done_milestones:
                continue
            ok, _ = check_success(spec, obs, self.flags)
            if ok:
                self.done_milestones.add(mid)
                newly.append(mid)
        if newly:
            self.save()
        return newly

    def resting(self, mid: str, now: float | None = None) -> bool:
        """A milestone that failed too often waits out its retry delay before the ladder offers it again."""
        fails = self.failed_milestones.get(mid, 0)
        if fails < GIVE_UP_AFTER:
            return False
        at = self.failed_at.get(mid)
        return at is not None and (now if now is not None else time.time()) - at < retry_delay(fails)

    def resting_milestones(self, now: float | None = None) -> list[str]:
        return [mid for mid, *_ in LADDER if mid not in self.done_milestones and self.resting(mid, now)]

    def next_milestone(self, now: float | None = None) -> tuple[str, str, str, dict[str, Any]] | None:
        for mid, desc, kind, spec, pre in LADDER:
            if mid in self.done_milestones:
                continue
            if self.resting(mid, now):
                continue
            if all(p in self.done_milestones for p in pre):
                return mid, desc, kind, spec
        return None

    def propose_curriculum_task(self) -> Task | None:
        nxt = self.next_milestone()
        if not nxt:
            return None
        mid, desc, kind, spec = nxt
        return Task(description=desc, kind=kind, success=spec, source=f"curriculum:{mid}")  # type: ignore[arg-type]

    def record_milestone_failure(self, task: Task) -> None:
        if task.source.startswith("curriculum:"):
            mid = task.source.split(":", 1)[1]
            self.failed_milestones[mid] = self.failed_milestones.get(mid, 0) + 1
            self.failed_at[mid] = time.time()
            self.save()

    def progress(self) -> dict[str, Any]:
        nm = self.next_milestone()
        return {"done": sorted(self.done_milestones), "total": len(LADDER), "next": nm[0] if nm else None, "goals": [g.title for g in self.goals if g.status == "active"]}

    def render(self) -> str:
        nm = self.next_milestone()
        lines = [f"Curriculum: {len(self.done_milestones)}/{len(LADDER)} milestones" + (f", next: {nm[1]}" if nm else " — ladder complete")]
        for g in sorted([g for g in self.goals if g.status == "active"], key=lambda g: g.priority)[:4]:
            t = g.current_task()
            lines.append(f"Goal (p{g.priority}, {g.source}): {g.title}" + (f" → current task: {t.description} (attempt {t.attempts + 1}/{t.max_attempts}{', last error: ' + t.last_error if t.last_error else ''})" if t else " (no open task)"))
        recent_fail = [t for g in self.goals for t in g.tasks if t.status == "failed"][-2:]
        if recent_fail:
            lines.append("Recently failed: " + "; ".join(f"{t.description} ({t.last_error[:80]})" for t in recent_fail))
        return "\n".join(lines)
