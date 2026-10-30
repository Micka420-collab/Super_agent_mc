"""Context assembly — turns the agent's state into the blocks the decision model reads.

Layout (static system prompt + volatile user message, for prompt caching):
  [IDENTITY] [DRIVES] [SENSORY] [BODY] [LAST ACTION] [GOALS] [PREVIOUSLY] [ABOUT PLAYERS]
  [PLACES] [MEMORIES] [TIMELINE] [DECISION]
Each block has a character budget so the whole message stays bounded whatever the world does.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from emeth.protocol import ActionResult, Observation, SkillRunResult


def _hunger_word(food: float) -> str:
    if food >= 18:
        return "full"
    if food >= 14:
        return "fine"
    if food >= 8:
        return "hungry"
    if food >= 4:
        return "very hungry"
    return "starving"


def _health_word(h: float) -> str:
    if h >= 18:
        return "healthy"
    if h >= 12:
        return "scratched"
    if h >= 7:
        return "hurt"
    if h >= 4:
        return "badly hurt"
    return "about to die"


def minutes_to(phase_from: float, target: float) -> int:
    """In-game minutes until `target` tick (24000 ticks = 20 real minutes)."""
    delta = (target - phase_from) % 24000
    return math.ceil(delta / 1200)


def render_sensory(obs: Observation, woke_by: str = "") -> str:
    s = obs.self_
    w = obs.world
    lines: list[str] = []
    if woke_by:
        lines.append(f"Woke by: {woke_by}")
    flags = []
    if s.isInWater:
        flags.append("in water")
    if s.isInLava:
        flags.append("IN LAVA")
    if s.isOnFire:
        flags.append("ON FIRE")
    if s.isSleeping:
        flags.append("sleeping")
    if s.oxygen < 20:
        flags.append(f"air {s.oxygen}/20")
    armor = [v for v in s.armor.values() if v]
    lines.append(
        f"Me: HP {s.health:.0f}/20 ({_health_word(s.health)}), food {s.food:.0f}/20 ({_hunger_word(s.food)}), saturation {s.saturation:.0f}, XP lvl {s.xpLevel:.0f}"
        + (f", armor: {', '.join(armor)}" if armor else ", no armor")
        + (f" [{', '.join(flags)}]" if flags else "")
    )
    held = s.heldItem.name if s.heldItem else "nothing"
    off = f", off-hand {s.offhandItem.name}" if s.offhandItem else ""
    lines.append(f"Position {s.position.short()} in the {s.dimension} ({s.biome}), {s.gameMode}. Holding {held}{off}.")
    if w.phase == "day":
        time_line = f"Day {w.day}, daytime (dusk in ~{minutes_to(w.timeOfDay, 12000)} min)"
    elif w.phase == "dusk":
        time_line = f"Day {w.day}, dusk — night is coming (dark in ~{minutes_to(w.timeOfDay, 13000)} min)"
    elif w.phase == "night":
        time_line = f"Day {w.day}, NIGHT (dawn in ~{minutes_to(w.timeOfDay, 23000)} min) — monsters spawn in the dark"
    else:
        time_line = f"Day {w.day}, dawn"
    weather = " Raining." if w.isRaining else ""
    thunder = " Thunderstorm!" if w.isThundering else ""
    lines.append(f"{time_line}.{weather}{thunder} Light here {w.lightLevel:.0f}/15.")
    lines.append(f"Standing on {obs.blocks.standingOn}; at feet {obs.blocks.atFeet}; above head {obs.blocks.atHead}." + (f" Facing {obs.blocks.facing.name} at {obs.blocks.facing.distance:.0f}m." if obs.blocks.facing else ""))
    if obs.vision and obs.vision.horizon:
        horizon = ", ".join(f"{k}: {v}" for k, v in list(obs.vision.horizon.items())[:8])
        lines.append(f"In view (by direction): {horizon}")
    return "\n".join(lines)


def render_entities(obs: Observation, max_each: int = 6) -> str:
    e = obs.entities
    lines: list[str] = []
    if e.players:
        lines.append("Players: " + "; ".join(f"{p.username or p.name} {p.distance:.0f}m {p.relative}" + (f" holding {p.heldItem}" if p.heldItem else "") + ("" if p.visible else " (not in sight)") for p in e.players[:max_each]))
    if e.hostiles:
        lines.append("THREATS: " + "; ".join(f"{h.name} {h.distance:.0f}m {h.relative}" + (f" HP {h.health:.0f}" if h.health is not None else "") for h in e.hostiles[:max_each]))
    if e.passives:
        groups: dict[str, int] = {}
        nearest: dict[str, float] = {}
        for p in e.passives:
            groups[p.name] = groups.get(p.name, 0) + 1
            nearest[p.name] = min(nearest.get(p.name, 999), p.distance)
        lines.append("Creatures: " + ", ".join(f"{n}×{c} (nearest {nearest[n]:.0f}m)" for n, c in list(groups.items())[:8]))
    if e.items:
        lines.append("Dropped items: " + ", ".join(f"{i.itemCount or '?'} {i.itemName or 'item'} {i.distance:.0f}m" for i in e.items[:max_each]))
    return "\n".join(lines) if lines else "Nobody around."


def render_blocks(obs: Observation, max_notable: int = 14) -> str:
    notable = obs.blocks.notable[:max_notable]
    parts = [f"{b.name} at {b.position.short()} {b.distance:.0f}m" for b in notable]
    counts = ", ".join(f"{k}×{v}" for k, v in list(obs.blocks.nearbyCounts.items())[:10])
    out = []
    if parts:
        out.append("Notable blocks: " + "; ".join(parts))
    if counts:
        out.append(f"Blocks nearby: {counts}")
    return "\n".join(out) if out else "Nothing notable nearby."


def render_inventory(obs: Observation, max_items: int = 30) -> str:
    inv = obs.inventory.summary()
    if not inv:
        return f"Inventory: empty ({obs.inventory.freeSlots}/{obs.inventory.totalSlots} slots free)."
    items = sorted(inv.items(), key=lambda kv: -kv[1])[:max_items]
    return f"Inventory ({obs.inventory.totalSlots - obs.inventory.freeSlots}/{obs.inventory.totalSlots} slots used): " + ", ".join(f"{n}×{c}" for n, c in items)


def render_action_result(result: ActionResult | SkillRunResult | None, max_chars: int = 900) -> str:
    if result is None:
        return "No action yet."
    label = result.action if isinstance(result, ActionResult) else f"skill {result.name}"
    status = "succeeded" if result.ok else f"FAILED ({result.errorCode}: {result.error})"
    if result.interruptedBy:
        status += f" — interrupted by {result.interruptedBy}"
    detail = ""
    if result.result is not None:
        import json

        detail = json.dumps(result.result, ensure_ascii=False)
        if len(detail) > max_chars:
            detail = detail[: max_chars - 1] + "…"
    secs = (result.finishedAt - result.startedAt) / 1000
    return f"{label} {status} in {secs:.1f}s." + (f" Result: {detail}" if detail else "")


@dataclass
class ContextBlocks:
    identity: str = ""
    drives: str = ""
    sensory: str = ""
    entities: str = ""
    blocks: str = ""
    inventory: str = ""
    body: str = ""
    last_action: str = ""
    goals: str = ""
    previously: str = ""
    about_players: str = ""
    places: str = ""
    memories: str = ""
    timeline: str = ""
    decision: str = ""
    extra: dict[str, str] = field(default_factory=dict)

    def render(self, budgets: dict[str, int] | None = None) -> str:
        b = {
            "identity": 1500, "drives": 600, "sensory": 1200, "entities": 900, "blocks": 900, "inventory": 700, "body": 700, "last_action": 1000,
            "goals": 900, "previously": 4500, "about_players": 1800, "places": 900, "memories": 2500, "timeline": 6000, "decision": 1500,
        }
        if budgets:
            b.update(budgets)
        order = [
            ("IDENTITY", self.identity), ("DRIVES", self.drives), ("SENSORY", self.sensory), ("AROUND ME", self.entities), ("BLOCKS", self.blocks),
            ("INVENTORY", self.inventory), ("BODY", self.body), ("LAST ACTION", self.last_action), ("GOALS", self.goals), ("PREVIOUSLY", self.previously),
            ("ABOUT PLAYERS", self.about_players), ("PLACES I KNOW", self.places), ("RELEVANT MEMORIES", self.memories), ("TIMELINE", self.timeline),
        ]
        parts = []
        for name, text in order:
            if not text:
                continue
            key = name.lower().replace(" ", "_")
            key = {"around_me": "entities", "places_i_know": "places", "relevant_memories": "memories"}.get(key, key)
            limit = b.get(key, 1000)
            if len(text) > limit:
                text = text[: limit - 1] + "…"
            parts.append(f"[{name}]\n{text}")
        for name, text in self.extra.items():
            parts.append(f"[{name}]\n{text}")
        if self.decision:
            parts.append(f"[DECISION]\n{self.decision[: b['decision']]}")
        return "\n\n".join(parts)


def observation_blocks(obs: Observation, woke_by: str = "") -> dict[str, Any]:
    return {
        "sensory": render_sensory(obs, woke_by),
        "entities": render_entities(obs),
        "blocks": render_blocks(obs),
        "inventory": render_inventory(obs),
    }


def compact_observation(obs: Observation) -> dict[str, Any]:
    """A small dict for logs and critics."""
    return {
        "pos": obs.self_.position.floored(),
        "hp": obs.self_.health,
        "food": obs.self_.food,
        "day": obs.world.day,
        "phase": obs.world.phase,
        "inventory": obs.inventory.summary(),
        "hostiles": len(obs.entities.hostiles),
        "players": [p.username for p in obs.entities.players if p.username],
    }
