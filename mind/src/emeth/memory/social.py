"""Social memory — a model of each player the agent meets (theory of mind, lightweight)."""

from __future__ import annotations

import re
import time

from emeth.memory.store import MemoryStore, Person

NEGATIVE = re.compile(r"\b(noob|idiot|stupid|shut up|kill you|hate|useless|dumb|ta gueule|nul|idiot|débile|crève)\b", re.IGNORECASE)
POSITIVE = re.compile(r"\b(thanks|thank you|merci|good job|bien joué|nice|love|great|awesome|bravo|cool|gg)\b", re.IGNORECASE)
PROMISE = re.compile(r"\b(i will|i'll|je vais|je te|promis|promise)\b", re.IGNORECASE)

RELATIONSHIPS = [(0.9, "best friend"), (0.75, "friend"), (0.55, "acquaintance"), (0.35, "stranger"), (0.0, "rival")]


def relationship_for(trust: float) -> str:
    for threshold, label in RELATIONSHIPS:
        if trust >= threshold:
            return label
    return "rival"


class SocialMemory:
    def __init__(self, store: MemoryStore, owner: str | None = None):
        self.store = store
        self.owner = owner

    def is_owner(self, username: str) -> bool:
        return bool(self.owner) and username == self.owner

    def on_chat(self, username: str, text: str) -> Person:
        p = self.store.get_person(username)
        trust = p.trust if p else (0.8 if self.is_owner(username) else 0.5)
        if NEGATIVE.search(text):
            trust -= 0.08
        if POSITIVE.search(text):
            trust += 0.04
        promise = text.strip() if PROMISE.search(text) and len(text) < 160 else None
        person = self.store.upsert_person(username, trust=trust, interaction=True, promise=promise, relationship=relationship_for(trust))
        return person

    def on_attacked_by(self, username: str) -> Person:
        p = self.store.get_person(username)
        trust = (p.trust if p else 0.5) - 0.25
        return self.store.upsert_person(username, trust=trust, note=f"attacked me ({time.strftime('%H:%M')})", relationship=relationship_for(trust))

    def on_gift(self, username: str, item: str, count: int) -> Person:
        p = self.store.get_person(username)
        trust = (p.trust if p else 0.5) + 0.1
        return self.store.upsert_person(username, trust=trust, note=f"gave me {count} {item}", relationship=relationship_for(trust))

    def on_seen(self, username: str) -> Person:
        return self.store.upsert_person(username, relationship=None)

    def remember(self, username: str, note: str) -> Person:
        return self.store.upsert_person(username, note=note)

    def describe(self, username: str) -> str:
        p = self.store.get_person(username)
        if not p:
            return f"{username}: never met before."
        tag = " (my owner)" if self.is_owner(username) else ""
        notes = "; ".join(p.notes[-4:])
        promises = "; ".join(p.promises[-2:])
        parts = [f"{p.username}{tag}: {p.relationship} (trust {p.trust:.0%}), {p.interactions} interactions"]
        if notes:
            parts.append(f"notes: {notes}")
        if promises:
            parts.append(f"promises: {promises}")
        return " — ".join(parts)

    def render_block(self, present: list[str], max_people: int = 6) -> str:
        """[ABOUT PLAYERS] block: present players first, then the most recent acquaintances."""
        lines: list[str] = []
        seen: set[str] = set()
        for u in present:
            lines.append(self.describe(u))
            seen.add(u)
        for p in self.store.list_people(limit=20):
            if len(lines) >= max_people:
                break
            if p.username not in seen:
                lines.append(self.describe(p.username))
                seen.add(p.username)
        return "\n".join(lines) if lines else "I have not met anyone yet."
