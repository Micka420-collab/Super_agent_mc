"""Homeostatic drives — the agent's inner weather.

Each drive is a 0..1 pressure computed from the observation and the timeline (no LLM). The decision
prompt shows the strongest ones so the model behaves like someone who *feels* hungry, unsafe, bored
or lonely, instead of a chatbot answering questions. Drives also gate the loop (an urgent safety
drive wakes the mind immediately).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from emeth.protocol import Observation


@dataclass
class DriveState:
    safety: float = 0.0  # threats, low health, darkness, night outside
    hunger: float = 0.0
    rest: float = 0.0  # night + tiredness → want to sleep
    curiosity: float = 0.3  # time since last discovery
    social: float = 0.2  # time since last conversation, players nearby
    mastery: float = 0.3  # time since last achievement / skill learned
    order: float = 0.1  # inventory full, no shelter, no tools
    mood: float = 0.6  # 0 miserable .. 1 happy; shaped by recent events

    def ranked(self) -> list[tuple[str, float]]:
        pairs = [(k, v) for k, v in self.__dict__.items() if k != "mood"]
        return sorted(pairs, key=lambda kv: kv[1], reverse=True)

    def urgent(self, threshold: float = 0.75) -> list[str]:
        return [k for k, v in self.ranked() if v >= threshold]

    def render(self) -> str:
        words = {
            "safety": "I feel unsafe", "hunger": "I am hungry", "rest": "I want to rest", "curiosity": "I want to explore and discover",
            "social": "I want company", "mastery": "I want to accomplish something", "order": "I want to get organised",
        }
        top = [(k, v) for k, v in self.ranked() if v >= 0.35][:4]
        mood = "cheerful" if self.mood > 0.7 else "content" if self.mood > 0.5 else "uneasy" if self.mood > 0.3 else "miserable"
        if not top:
            return f"Mood: {mood}. Nothing presses on me right now."
        return f"Mood: {mood}. " + "; ".join(f"{words[k]} ({v:.0%})" for k, v in top) + "."


@dataclass
class Drives:
    state: DriveState = field(default_factory=DriveState)
    last_discovery: float = field(default_factory=time.time)
    last_social: float = field(default_factory=time.time)
    last_achievement: float = field(default_factory=time.time)
    last_sleep: float = field(default_factory=time.time)
    recent_pain: float = 0.0
    recent_joy: float = 0.0

    def on_event(self, kind: str) -> None:
        now = time.time()
        if kind in ("discovery", "entity.spawn", "player.joined"):
            self.last_discovery = now
        if kind in ("chat_in", "whisper_in", "social"):
            self.last_social = now
        if kind in ("achievement", "skill_learned", "built"):
            self.last_achievement = now
            self.recent_joy = min(1.0, self.recent_joy + 0.3)
        if kind in ("damage", "death", "failure"):
            self.recent_pain = min(1.0, self.recent_pain + (0.6 if kind == "death" else 0.2))
        if kind == "sleep":
            self.last_sleep = now

    def update(self, obs: Observation) -> DriveState:
        now = time.time()
        s = obs.self_
        w = obs.world
        hostiles = obs.entities.hostiles
        nearest = min((h.distance for h in hostiles), default=999.0)
        threat = 0.0
        if hostiles:
            threat = max(0.3, min(1.0, 1.2 - nearest / 20))
        health_fear = max(0.0, (14 - s.health) / 14)
        dark = 0.0
        if w.phase == "night" and w.skyLight > 4:
            dark = 0.45  # outside at night
        if w.lightLevel < 7 and w.skyLight < 4:
            dark = max(dark, 0.3)  # in a dark cave
        self.state.safety = min(1.0, max(threat, health_fear * 0.9) + dark * 0.5 + (0.4 if s.isOnFire or s.isInLava else 0) + (0.3 if s.oxygen < 10 else 0))
        self.state.hunger = min(1.0, max(0.0, (16 - s.food) / 16) ** 1.3)
        hours_awake = (now - self.last_sleep) / 3600
        self.state.rest = min(1.0, (0.5 if w.phase in ("night", "dusk") else 0.05) + min(0.4, hours_awake / 8))
        self.state.curiosity = min(1.0, 0.2 + (now - self.last_discovery) / 1800)
        players_near = len(obs.entities.players)
        self.state.social = min(1.0, (0.15 + (now - self.last_social) / 2400) * (1.6 if players_near else 0.7))
        self.state.mastery = min(1.0, 0.25 + (now - self.last_achievement) / 2400)
        inv = obs.inventory
        tools = [i for i in inv.items if i.name.endswith(("_pickaxe", "_axe", "_sword", "_shovel"))]
        self.state.order = min(1.0, (0.5 if inv.freeSlots <= 2 else 0.0) + (0.3 if not tools else 0.0) + (0.2 if not any(v for v in s.armor.values()) else 0.0))
        # mood: decays toward baseline, pushed by pain/joy and satisfied needs
        self.recent_pain *= 0.92
        self.recent_joy *= 0.95
        satisfaction = 1 - (self.state.hunger * 0.5 + self.state.safety * 0.5)
        self.state.mood = max(0.0, min(1.0, 0.55 * satisfaction + 0.25 * (1 - self.recent_pain) + 0.2 * self.recent_joy + 0.1))
        return self.state

    def wake_priority(self) -> float:
        """How urgently the loop should think, 0..1."""
        return max(self.state.safety, self.state.hunger * 0.8, self.state.rest * 0.5)
