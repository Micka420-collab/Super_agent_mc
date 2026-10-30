"""Episodic timeline — what happened, in order, with duplicate collapsing (VoxelMind pattern)."""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from emeth.memory.store import MemoryStore

IMPORTANCE = {
    "chat_in": 0.5,
    "whisper_in": 0.6,
    "said": 0.4,
    "action": 0.2,
    "result": 0.3,
    "failure": 0.5,
    "damage": 0.4,
    "death": 0.9,
    "respawn": 0.5,
    "presence": 0.3,
    "threat": 0.4,
    "reflex": 0.3,
    "discovery": 0.6,
    "achievement": 0.8,
    "note": 0.3,
    "sleep": 0.5,
    "wake": 0.3,
    "social": 0.6,
    "plan": 0.4,
}


@dataclass
class TimelineEntry:
    ts: float
    kind: str
    text: str
    count: int = 1
    first_ts: float = 0.0
    actors: list[str] = field(default_factory=list)

    def render(self, now: float) -> str:
        ago = _ago(now - self.ts)
        extra = f" (x{self.count}, first {_ago(now - self.first_ts)})" if self.count > 1 else ""
        return f"- [{ago}] {self.kind}: {self.text}{extra}"


def _ago(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s ago"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    return f"{seconds // 3600}h{(seconds % 3600) // 60:02d} ago"


class Timeline:
    """Ring buffer of recent events, persisted to the store as episodes."""

    def __init__(self, store: MemoryStore | None = None, capacity: int = 600):
        self.store = store
        self.entries: deque[TimelineEntry] = deque(maxlen=capacity)
        self.day = 0
        self.position: tuple[float, float, float] | None = None
        self.dimension: str | None = None
        self.events_since_rewrite = 0

    def set_context(self, day: int, position: tuple[float, float, float] | None, dimension: str | None) -> None:
        self.day = day
        self.position = position
        self.dimension = dimension

    def add(self, kind: str, text: str, *, actors: list[str] | None = None, importance: float | None = None, ts: float | None = None) -> TimelineEntry:
        ts = ts or time.time()
        text = text.strip()
        if self.entries and self.entries[-1].kind == kind and self.entries[-1].text == text:
            last = self.entries[-1]
            last.count += 1
            last.ts = ts
            return last
        entry = TimelineEntry(ts=ts, kind=kind, text=text, first_ts=ts, actors=actors or [])
        self.entries.append(entry)
        self.events_since_rewrite += 1
        if self.store is not None:
            self.store.add_episode(kind, text, ts=ts, day=self.day, importance=importance if importance is not None else IMPORTANCE.get(kind, 0.3), dimension=self.dimension, pos=self.position, actors=actors)
        return entry

    def recent(self, limit: int = 30, kinds: set[str] | None = None, since_s: float | None = None) -> list[TimelineEntry]:
        now = time.time()
        out = [e for e in self.entries if (kinds is None or e.kind in kinds) and (since_s is None or now - e.ts <= since_s)]
        return out[-limit:]

    def render(self, *, chat_lines: int = 24, chat_minutes: int = 30, other_lines: int = 30, max_chars: int = 6000) -> str:
        """Window = recent chat (≥ chat_lines, ≤ chat_minutes) + the last `other_lines` non-chat rows, merged by time."""
        now = time.time()
        chat_kinds = {"chat_in", "whisper_in", "said"}
        chats = [e for e in self.entries if e.kind in chat_kinds]
        recent_chats = [e for e in chats if now - e.ts <= chat_minutes * 60]
        if len(recent_chats) < chat_lines:
            recent_chats = chats[-chat_lines:]
        others = [e for e in self.entries if e.kind not in chat_kinds][-other_lines:]
        unique: dict[int, TimelineEntry] = {id(e): e for e in recent_chats + others}
        merged = sorted(unique.values(), key=lambda e: e.ts)
        lines: list[str] = []
        total = 0
        for e in reversed(merged):
            line = e.render(now)
            if total + len(line) > max_chars:
                break
            lines.append(line)
            total += len(line) + 1
        return "\n".join(reversed(lines)) if lines else "(nothing yet)"

    def since_rewrite(self) -> int:
        return self.events_since_rewrite

    def mark_rewritten(self) -> None:
        self.events_since_rewrite = 0
