"""Procedural memory — the skill library (Voyager pattern, with success records and versions).

A skill is a JavaScript file `async function main(api, args)` with a metadata header. The code lives
on disk (portable, reviewable, git-friendly); descriptions and embeddings live in the store for
retrieval. Skills with poor success rates sink in retrieval and can be retired by consolidation.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path

from emeth.llm.embeddings import Embedder
from emeth.memory.store import MemoryStore, SkillRecord

HEADER = re.compile(r"^/\*\*\s*@skill\s+(?P<name>[\w-]+)\s*\n(?P<meta>.*?)\*/", re.DOTALL)
SAFE_NAME = re.compile(r"[^a-z0-9_]+")


def safe_skill_name(text: str) -> str:
    s = SAFE_NAME.sub("_", text.lower()).strip("_")
    if not s:
        s = "skill"
    if s[0].isdigit():
        s = f"s_{s}"
    return s[:64]


@dataclass
class Skill:
    name: str
    code: str
    description: str
    tags: list[str]
    version: int = 1
    record: SkillRecord | None = None

    def header(self) -> str:
        return (
            f"/** @skill {self.name}\n"
            f" * description: {self.description.replace(chr(10), ' ')}\n"
            f" * tags: {', '.join(self.tags)}\n"
            f" * version: {self.version}\n"
            f" * updated: {time.strftime('%Y-%m-%dT%H:%M:%S')}\n"
            " */\n"
        )

    def source(self) -> str:
        body = HEADER.sub("", self.code, count=1).lstrip()
        return self.header() + body


class SkillLibrary:
    def __init__(self, directory: Path, store: MemoryStore, embedder: Embedder | None = None):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.store = store
        self.embedder = embedder

    async def sync_from_disk(self) -> int:
        """Index skill files that exist on disk but not in the store (e.g. after a git pull)."""
        count = 0
        known = {s.name for s in self.store.list_skills()}
        for file in sorted(self.dir.glob("*.js")):
            parsed = parse_skill_file(file.read_text(encoding="utf-8"), fallback_name=file.stem)
            if parsed.name in known:
                continue
            emb = await self.embedder.embed_one(f"{parsed.name}: {parsed.description}") if self.embedder else None
            self.store.upsert_skill(parsed.name, file.name, parsed.description, tags=parsed.tags, embedding=emb)
            count += 1
        return count

    async def add(self, name: str, code: str, description: str, tags: list[str] | None = None) -> Skill:
        name = safe_skill_name(name)
        existing = self.store.get_skill(name)
        version = (existing.version + 1) if existing else 1
        skill = Skill(name=name, code=code, description=description, tags=tags or [], version=version)
        path = self.dir / f"{name}.js"
        if existing:
            # keep the previous version for rollback
            old = self.dir / f"{name}.v{existing.version}.js"
            if path.exists() and not old.exists():
                path.replace(old)
        path.write_text(skill.source(), encoding="utf-8")
        emb = await self.embedder.embed_one(f"{name}: {description}") if self.embedder else None
        skill.record = self.store.upsert_skill(name, path.name, description, tags=tags or [], embedding=emb, bump_version=bool(existing))
        return skill

    def get(self, name: str) -> Skill | None:
        rec = self.store.get_skill(name)
        if not rec:
            return None
        file = self.dir / rec.path
        if not file.exists():
            return None
        parsed = parse_skill_file(file.read_text(encoding="utf-8"), fallback_name=name)
        parsed.record = rec
        parsed.version = rec.version
        return parsed

    def records(self) -> list[SkillRecord]:
        return self.store.list_skills()

    async def retrieve(self, query: str, limit: int = 5) -> list[Skill]:
        if not self.embedder:
            return []
        emb = await self.embedder.embed_one(query)
        out = []
        for rec in self.store.search_skills(emb, limit=limit):
            s = self.get(rec.name)
            if s:
                s.record = rec
                out.append(s)
        return out

    def record_outcome(self, name: str, ok: bool, ms: float) -> None:
        self.store.record_skill_outcome(name, ok, ms)

    def retire(self, name: str) -> None:
        rec = self.store.get_skill(name)
        if rec:
            file = self.dir / rec.path
            if file.exists():
                file.replace(self.dir / f"{name}.retired.js")
            self.store.delete_skill(name)

    def describe_for_prompt(self, skills: list[Skill], max_chars: int = 6000) -> str:
        parts: list[str] = []
        total = 0
        for s in skills:
            rate = f"{s.record.success_rate:.0%} over {s.record.uses} uses" if s.record and s.record.uses else "untested"
            block = f"// {s.name} — {s.description} ({rate})\n{HEADER.sub('', s.code, count=1).strip()}"
            if total + len(block) > max_chars:
                break
            parts.append(block)
            total += len(block)
        return "\n\n".join(parts)

    def export_index(self) -> dict[str, object]:
        return {
            "skills": [
                {"name": r.name, "description": r.description, "tags": r.tags, "version": r.version, "uses": r.uses, "success_rate": round(r.success_rate, 3)}
                for r in self.store.list_skills()
            ]
        }

    def write_index(self) -> None:
        (self.dir / "index.json").write_text(json.dumps(self.export_index(), indent=2, ensure_ascii=False), encoding="utf-8")


def parse_skill_file(text: str, fallback_name: str) -> Skill:
    m = HEADER.match(text)
    name = fallback_name
    description = ""
    tags: list[str] = []
    version = 1
    if m:
        name = m.group("name")
        for line in m.group("meta").splitlines():
            line = line.strip().lstrip("*").strip()
            if line.startswith("description:"):
                description = line.split(":", 1)[1].strip()
            elif line.startswith("tags:"):
                tags = [t.strip() for t in line.split(":", 1)[1].split(",") if t.strip()]
            elif line.startswith("version:"):
                try:
                    version = int(line.split(":", 1)[1].strip())
                except ValueError:
                    version = 1
    return Skill(name=safe_skill_name(name), code=text, description=description, tags=tags, version=version)
