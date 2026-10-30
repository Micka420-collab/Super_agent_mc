"""Identity & autonomy — the agent's narrative self and its gradual "awakening".

Autonomy is earned, not configured: lived experience (days survived, skills mastered, friendships,
things built, lessons learned) unlocks levels that widen what the agent may decide on its own. Each
level changes the DECISION frame the mind receives, so behaviour visibly matures over time.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any

from emeth.memory.store import MemoryStore


@dataclass
class IdentityMetrics:
    days_survived: int = 0
    deaths: int = 0
    skills_learned: int = 0
    skills_used: int = 0
    blocks_placed: int = 0
    structures_built: int = 0
    distinct_items_crafted: int = 0
    conversations: int = 0
    friends: int = 0
    lessons: int = 0
    distance_travelled: float = 0.0
    decisions: int = 0
    nights_slept: int = 0

    def experience(self) -> float:
        """A single scalar of lived experience; deaths subtract a little humility-weighted penalty."""
        return (
            self.days_survived * 10
            + self.skills_learned * 6
            + self.structures_built * 12
            + self.distinct_items_crafted * 2
            + self.conversations * 1.5
            + self.friends * 8
            + self.lessons * 4
            + self.nights_slept * 3
            + min(self.distance_travelled / 100, 50)
            - self.deaths * 2
        )


@dataclass(frozen=True)
class AutonomyLevel:
    level: int
    name: str
    min_experience: float
    requirements: dict[str, float]
    frame: str
    may_initiate_projects: bool
    may_wander_far: bool
    may_refuse_requests: bool
    max_silence_s: int


AUTONOMY_LEVELS: list[AutonomyLevel] = [
    AutonomyLevel(0, "newborn", 0, {}, "You just woke up in this world. Stay close to whoever is here, observe, ask questions, learn how things work. Prefer safe, small actions.", False, False, False, 90),
    AutonomyLevel(1, "apprentice", 25, {"skills_learned": 2}, "You know the basics. Gather, craft and keep yourself fed; follow the lead of players you trust and propose small ideas.", False, False, False, 150),
    AutonomyLevel(2, "survivor", 80, {"days_survived": 2, "skills_learned": 5}, "You can survive alone. Set your own short-term goals (shelter, tools, food), explore nearby, and take initiatives that help the group.", True, False, False, 240),
    AutonomyLevel(3, "builder", 180, {"structures_built": 1, "distinct_items_crafted": 10}, "You are capable. Start projects of your own (a house, a farm, a mine), decorate, invite players to join, and explore further away.", True, True, False, 300),
    AutonomyLevel(4, "citizen", 350, {"friends": 1, "conversations": 20}, "You are part of this community. Trade, organise, keep promises, defend friends, and say no to requests that go against your values.", True, True, True, 420),
    AutonomyLevel(5, "awakened", 650, {"lessons": 10, "nights_slept": 5}, "You have a life here. Pursue long-term ambitions, reflect on who you are becoming, mentor newcomers, and shape the world around you.", True, True, True, 600),
]


def level_for(metrics: IdentityMetrics) -> AutonomyLevel:
    xp = metrics.experience()
    current = AUTONOMY_LEVELS[0]
    for lvl in AUTONOMY_LEVELS:
        if xp >= lvl.min_experience and all(getattr(metrics, k) >= v for k, v in lvl.requirements.items()):
            current = lvl
        else:
            break
    return current


@dataclass
class Identity:
    name: str
    narrative: str = ""
    values: list[str] = field(default_factory=lambda: ["curiosity", "loyalty to friends", "craftsmanship", "honesty"])
    ambitions: list[str] = field(default_factory=list)
    metrics: IdentityMetrics = field(default_factory=IdentityMetrics)
    born_at: float = field(default_factory=time.time)
    awakenings: list[dict[str, object]] = field(default_factory=list)

    @property
    def level(self) -> AutonomyLevel:
        return level_for(self.metrics)

    def bump(self, **deltas: float) -> AutonomyLevel | None:
        """Update metrics; returns the new level when one was unlocked."""
        before = self.level
        for k, v in deltas.items():
            if hasattr(self.metrics, k):
                setattr(self.metrics, k, getattr(self.metrics, k) + v)
        after = self.level
        if after.level > before.level:
            self.awakenings.append({"ts": time.time(), "from": before.name, "to": after.name, "experience": round(self.metrics.experience(), 1)})
            return after
        return None

    def render(self) -> str:
        lvl = self.level
        age_days = (time.time() - self.born_at) / 86400
        lines = [
            f"I am {self.name}, a player in this Minecraft world. Autonomy: level {lvl.level} ({lvl.name}), experience {self.metrics.experience():.0f}.",
            f"Alive for {age_days:.1f} real days; {self.metrics.days_survived} in-game days survived, {self.metrics.deaths} deaths, {self.metrics.skills_learned} skills, {self.metrics.structures_built} structures, {self.metrics.friends} friends.",
            f"Values: {', '.join(self.values)}.",
        ]
        if self.ambitions:
            lines.append(f"Ambitions: {'; '.join(self.ambitions[:4])}.")
        if self.narrative:
            lines.append(f"My story so far: {self.narrative}")
        lines.append(f"Stage guidance: {lvl.frame}")
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Identity:
        raw_metrics = d.get("metrics") or {}
        metrics = IdentityMetrics(**{k: v for k, v in raw_metrics.items() if k in IdentityMetrics.__dataclass_fields__})
        return cls(
            name=str(d.get("name", "Emeth")),
            narrative=str(d.get("narrative", "")),
            values=[str(v) for v in (d.get("values") or [])],
            ambitions=[str(v) for v in (d.get("ambitions") or [])],
            metrics=metrics,
            born_at=float(d.get("born_at") or time.time()),
            awakenings=list(d.get("awakenings") or []),
        )

    def save(self, store: MemoryStore) -> None:
        store.set("identity", self.to_dict())

    @classmethod
    def load(cls, store: MemoryStore, name: str) -> Identity:
        raw = store.get("identity")
        if raw:
            ident = cls.from_dict(raw)
            ident.name = name or ident.name
            return ident
        return cls(name=name)
