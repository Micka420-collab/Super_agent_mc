"""Consolidation — what happens when the agent sleeps.

Two mechanisms:
  * `rewrite_rolling()` — every N timeline events, rewrite the two rolling memory blocks
    ([PREVIOUSLY] shared past / recent developments, and [ABOUT PLAYERS]) with strict source
    attribution rules (VoxelMind pattern).
  * `dream(day)` — when the body sleeps in a bed: turn the day's episodes into a session page,
    extract lessons / places / people / project facts into semantic pages, update the identity
    narrative, retire bad skills, run the retention sweep. Sleep is literally when memory settles.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatRequest, Message
from emeth.memory.episodic import Timeline
from emeth.memory.procedural import SkillLibrary
from emeth.memory.semantic import Wiki, WikiPage
from emeth.memory.social import SocialMemory
from emeth.memory.spatial import WorldGraph
from emeth.memory.store import MemoryStore
from emeth.self.identity import Identity

log = logging.getLogger(__name__)

ROLLING_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "previously": {"type": "string", "description": "Full replacement text, two sections: 'Shared past' and 'Recent developments'. Max 3500 characters."},
        "about_players": {"type": "string", "description": "Full replacement text about the players I know: facts they told me, how they treat me, promises. Max 1500 characters."},
    },
    "required": ["previously", "about_players"],
}

DREAM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "day_summary": {"type": "string", "description": "A first-person narrative of the day in 6-12 sentences."},
        "lessons": {"type": "array", "items": {"type": "object", "properties": {"title": {"type": "string"}, "text": {"type": "string"}}, "required": ["title", "text"]}},
        "places": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "kind": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"}, "notes": {"type": "string"}}, "required": ["name", "kind", "x", "y", "z"]}},
        "people": {"type": "array", "items": {"type": "object", "properties": {"username": {"type": "string"}, "note": {"type": "string"}, "trust_delta": {"type": "number"}}, "required": ["username", "note"]}},
        "projects": {"type": "array", "items": {"type": "object", "properties": {"title": {"type": "string"}, "status": {"type": "string"}, "next_step": {"type": "string"}}, "required": ["title", "status"]}},
        "identity_update": {"type": "string", "description": "One or two sentences to append to my life story, or empty."},
        "ambitions": {"type": "array", "items": {"type": "string"}},
        "mood": {"type": "string"},
    },
    "required": ["day_summary", "lessons", "places", "people", "projects", "identity_update", "ambitions", "mood"],
}

MEMORY_GUIDE = (
    "Rules for writing memory: only state what the evidence supports. Attribute sources: 'go_to reported reaching the farm' is not "
    "'I was at the farm'; 'Steve said he lives north' is not 'Steve lives north'. Never infer preferences from repeated tool use. "
    "Keep names, coordinates and quantities exact. Prefer durable facts over moment-to-moment state. Write in the first person."
)


@dataclass
class ConsolidationResult:
    session_page: str | None = None
    lessons: int = 0
    places: int = 0
    people: int = 0
    projects: int = 0
    retired_skills: list[str] = field(default_factory=list)
    sweep: dict[str, int] = field(default_factory=dict)
    narrative_updated: bool = False


class Consolidator:
    def __init__(self, router: LLMRouter, store: MemoryStore, wiki: Wiki, timeline: Timeline, social: SocialMemory, graph: WorldGraph, skills: SkillLibrary, identity: Identity, language: str = "fr"):
        self.router = router
        self.store = store
        self.wiki = wiki
        self.timeline = timeline
        self.social = social
        self.graph = graph
        self.skills = skills
        self.identity = identity
        self.language = language

    # ---- rolling memory ---------------------------------------------------------------------
    def rolling(self) -> tuple[str, str]:
        return (self.store.get("rolling.previously", ""), self.store.get("rolling.about_players", ""))

    async def rewrite_rolling(self) -> tuple[str, str]:
        previously, about = self.rolling()
        transcript = self.timeline.render(chat_lines=40, chat_minutes=120, other_lines=80, max_chars=14_000)
        prompt = (
            f"{MEMORY_GUIDE}\n\nCurrent [PREVIOUSLY] block:\n{previously or '(empty)'}\n\nCurrent [ABOUT PLAYERS] block:\n{about or '(empty)'}\n\n"
            f"New timeline since the last rewrite (seq | time | kind | text):\n{transcript}\n\n"
            "Rewrite both blocks as full replacements, merging old and new, dropping stale detail. Respect the character limits."
        )
        req = ChatRequest(messages=[Message(role="system", content=f"You are the memory writer of a Minecraft player named {self.identity.name}. Write in {self.language}."), Message(role="user", content=prompt)], tier="fast", temperature=0.2, json_schema=ROLLING_SCHEMA, json_schema_name="rolling_memory", purpose="memory.rolling")
        try:
            resp = await self.router.chat(req)
        except Exception as exc:  # noqa: BLE001
            log.warning("rolling rewrite failed: %s", exc)
            return previously, about
        data = resp.json_data or {}
        new_prev = str(data.get("previously") or previously)[:4500]
        new_about = str(data.get("about_players") or about)[:1800]
        self.store.set("rolling.previously", new_prev)
        self.store.set("rolling.about_players", new_about)
        self.timeline.mark_rewritten()
        return new_prev, new_about

    # ---- dreaming ---------------------------------------------------------------------------
    async def dream(self, day: int) -> ConsolidationResult:
        result = ConsolidationResult()
        episodes = self.store.unconsolidated_episodes(limit=600)
        if not episodes:
            result.sweep = self.store.sweep_pages()
            return result
        lines = [f"{time.strftime('%H:%M', time.localtime(e.ts))} | {e.kind} | {e.text}" for e in episodes]
        transcript = "\n".join(lines)[-16_000:]
        previously, _ = self.rolling()
        prompt = (
            f"{MEMORY_GUIDE}\n\nI am going to sleep after day {day}. Here is everything that happened since my last sleep:\n{transcript}\n\n"
            f"My story so far: {self.identity.narrative or '(none yet)'}\n\nWhat I remembered previously: {previously or '(nothing)'}\n\n"
            "Consolidate: write the day summary, extract durable lessons (what works, what hurts, what players want), notable places with exact coordinates, "
            "facts about people, project status, and a short identity update if something meaningful changed."
        )
        req = ChatRequest(messages=[Message(role="system", content=f"You are the dreaming mind of a Minecraft player named {self.identity.name}. Write in {self.language}."), Message(role="user", content=prompt)], tier="smart", temperature=0.3, json_schema=DREAM_SCHEMA, json_schema_name="dream", purpose="memory.dream")
        try:
            resp = await self.router.chat(req)
            data = resp.json_data or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("dream failed: %s", exc)
            data = {}

        summary = str(data.get("day_summary") or self._fallback_summary(episodes))
        page = await self.wiki.write(
            WikiPage(path=f"sessions/day-{day:04d}.md", kind="session", title=f"Day {day}", body=summary, abstract=summary[:200], tags=["session"], salience=0.6)
        )
        result.session_page = page.path
        for lesson in data.get("lessons") or []:
            await self.wiki.note("lesson", str(lesson.get("title", "lesson"))[:80], str(lesson.get("text", "")), tags=["lesson"], salience=0.7)
            result.lessons += 1
            self.identity.bump(lessons=1)
        for place in data.get("places") or []:
            try:
                name = str(place["name"])[:60]
                x, y, z = float(place["x"]), float(place["y"]), float(place["z"])
            except (KeyError, TypeError, ValueError):
                continue
            kind = str(place.get("kind", "place"))[:30]
            self.store.upsert_place(name, kind, x, y, z, notes=str(place.get("notes", ""))[:300])
            self.graph.mark_place(name, x, y, z, kind=kind, notes=str(place.get("notes", ""))[:120])
            result.places += 1
        for person in data.get("people") or []:
            username = str(person.get("username", "")).strip()
            if not username:
                continue
            current = self.store.get_person(username)
            trust = (current.trust if current else 0.5) + float(person.get("trust_delta") or 0) * 0.1
            self.store.upsert_person(username, trust=trust, note=str(person.get("note", ""))[:200])
            result.people += 1
        for project in data.get("projects") or []:
            title = str(project.get("title", "project"))[:80]
            body = f"Status: {project.get('status', '')}\nNext step: {project.get('next_step', '')}"
            await self.wiki.note("project", title, body, tags=["project"], salience=0.6)
            result.projects += 1
        update = str(data.get("identity_update") or "").strip()
        if update:
            self.identity.narrative = (self.identity.narrative + " " + update).strip()[-2500:]
            result.narrative_updated = True
        ambitions = [str(a)[:100] for a in (data.get("ambitions") or []) if str(a).strip()]
        if ambitions:
            self.identity.ambitions = ambitions[:5]
        self.identity.bump(nights_slept=1)
        self.identity.metrics.friends = sum(1 for p in self.store.list_people() if p.trust >= 0.75)
        self.identity.save(self.store)

        # retire skills that keep failing
        for rec in self.skills.records():
            if rec.uses >= 4 and rec.success_rate < 0.25:
                self.skills.retire(rec.name)
                result.retired_skills.append(rec.name)
        self.store.mark_consolidated([e.id for e in episodes])
        result.sweep = self.store.sweep_pages()
        self.graph.save()
        await self.wiki.write(
            WikiPage(path="identity/self.md", kind="identity", title=f"Who I am — {self.identity.name}", body=self.identity.render(), abstract=self.identity.narrative[:200], pinned=True, salience=1.0)
        )
        return result

    @staticmethod
    def _fallback_summary(episodes: list[Any]) -> str:
        kinds: dict[str, int] = {}
        for e in episodes:
            kinds[e.kind] = kinds.get(e.kind, 0) + 1
        highlights = [e.text for e in episodes if e.importance >= 0.6][-6:]
        return "Day summary (automatic): " + ", ".join(f"{v} {k}" for k, v in sorted(kinds.items(), key=lambda kv: -kv[1])) + (". Highlights: " + " | ".join(highlights) if highlights else ".")

    def export_json(self) -> str:
        return json.dumps({"identity": self.identity.to_dict(), "rolling": dict(zip(("previously", "about_players"), self.rolling(), strict=True))}, ensure_ascii=False, indent=2)
