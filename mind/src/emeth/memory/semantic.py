"""Semantic memory — a markdown wiki (truth) indexed in SQLite (search).

Page kinds: `concept` (how the world works), `lesson` (what I learned the hard way), `place`,
`person`, `session` (a day's story), `project` (ongoing build / goal), `rule` (standing instruction
from the owner), `identity` (who I am). Pages carry YAML-ish frontmatter so the bundle stays readable
by humans and portable across LLM vendors (ai-memory lesson).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path

from emeth.llm.embeddings import Embedder
from emeth.memory.store import MemoryStore, Page

FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
SLUG = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    s = SLUG.sub("-", text.lower()).strip("-")
    return s[:60] or "page"


@dataclass
class WikiPage:
    path: str
    kind: str
    title: str
    body: str
    abstract: str = ""
    entities: list[str] | None = None
    tags: list[str] | None = None
    pinned: bool = False
    salience: float = 0.5


class Wiki:
    def __init__(self, root: Path, store: MemoryStore, embedder: Embedder | None = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.store = store
        self.embedder = embedder

    # ---- writing ---------------------------------------------------------------------------
    def render_markdown(self, page: WikiPage) -> str:
        fm = [
            "---",
            f"title: {page.title}",
            f"kind: {page.kind}",
            f"abstract: {page.abstract.replace(chr(10), ' ')}",
            f"entities: [{', '.join(page.entities or [])}]",
            f"tags: [{', '.join(page.tags or [])}]",
            f"pinned: {'true' if page.pinned else 'false'}",
            f"salience: {page.salience:.2f}",
            f"updated: {time.strftime('%Y-%m-%dT%H:%M:%S')}",
            "---",
            "",
        ]
        return "\n".join(fm) + page.body.rstrip() + "\n"

    async def write(self, page: WikiPage) -> Page:
        path = page.path if page.path.endswith(".md") else f"{page.path}.md"
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(self.render_markdown(page), encoding="utf-8")
        embedding = await self.embedder.embed_one(f"{page.title}\n{page.abstract}\n{page.body[:2000]}") if self.embedder else None
        self.store.upsert_page(path, page.kind, page.title, page.body, abstract=page.abstract, entities=page.entities or [], tags=page.tags or [], pinned=page.pinned, salience=page.salience, embedding=embedding)
        stored = self.store.get_page(path)
        assert stored is not None
        return stored

    async def note(self, kind: str, title: str, body: str, *, entities: list[str] | None = None, tags: list[str] | None = None, salience: float = 0.5, pinned: bool = False, abstract: str | None = None) -> Page:
        path = f"{kind}s/{slugify(title)}.md"
        existing = self.store.get_page(path)
        if existing and body.strip() not in existing.body:
            body = (existing.body.rstrip() + "\n\n" + body.strip())[-6000:]
        return await self.write(WikiPage(path=path, kind=kind, title=title, body=body, abstract=abstract or body.strip().split("\n")[0][:200], entities=entities, tags=tags, salience=salience, pinned=pinned))

    def delete(self, path: str) -> None:
        file = self.root / path
        if file.exists():
            file.unlink()
        self.store.delete_page(path)

    # ---- reading ---------------------------------------------------------------------------
    def read(self, path: str) -> Page | None:
        page = self.store.get_page(path)
        if page:
            self.store.touch_page(page.id)
        return page

    async def search(self, query: str, limit: int = 6, kinds: list[str] | None = None) -> list[Page]:
        embedding = await self.embedder.embed_one(query) if self.embedder else None
        pages = self.store.search_pages(query, embedding, limit=limit, kinds=kinds)
        for p in pages:
            self.store.touch_page(p.id)
        return pages

    def pinned(self) -> list[Page]:
        return [p for p in self.store.list_pages(limit=1000) if p.pinned]

    def brief(self, max_chars: int = 4000, query_pages: list[Page] | None = None) -> str:
        """Tiered session brief (ai-memory): pinned/rule/identity pages first, then relevant pages, within a byte budget."""
        core = [p for p in self.store.list_pages(limit=1000) if p.pinned or p.kind in ("rule", "identity")]
        core.sort(key=lambda p: (p.kind != "identity", p.kind != "rule", -p.salience))
        chosen: list[Page] = []
        seen: set[int] = set()
        for p in core + (query_pages or []):
            if p.id in seen:
                continue
            seen.add(p.id)
            chosen.append(p)
        lines: list[str] = []
        total = 0
        for p in chosen:
            # L0 abstract, L1 first 500 chars, L2 full body when it fits
            body = p.body.strip()
            text = body if total + len(body) < max_chars * 0.6 else (body[:500] + "…" if len(body) > 500 else body)
            if total + len(text) + len(p.title) + 10 > max_chars:
                text = p.abstract or body[:200]
                if total + len(text) + len(p.title) + 10 > max_chars:
                    break
            lines.append(f"### {p.title} [{p.kind}]\n{text}")
            total += len(text) + len(p.title) + 10
        return "\n\n".join(lines)

    # ---- rebuild index from files (recovery) ------------------------------------------------
    async def reindex(self) -> int:
        count = 0
        for file in self.root.rglob("*.md"):
            text = file.read_text(encoding="utf-8")
            m = FRONTMATTER.match(text)
            meta: dict[str, str] = {}
            body = text
            if m:
                body = text[m.end() :]
                for line in m.group(1).splitlines():
                    if ":" in line:
                        k, v = line.split(":", 1)
                        meta[k.strip()] = v.strip()
            rel = file.relative_to(self.root).as_posix()
            page = WikiPage(
                path=rel,
                kind=meta.get("kind", rel.split("/")[0].rstrip("s") or "concept"),
                title=meta.get("title", file.stem),
                body=body.strip(),
                abstract=meta.get("abstract", ""),
                entities=[e.strip() for e in meta.get("entities", "[]").strip("[]").split(",") if e.strip()],
                tags=[t.strip() for t in meta.get("tags", "[]").strip("[]").split(",") if t.strip()],
                pinned=meta.get("pinned", "false") == "true",
                salience=float(meta.get("salience", "0.5") or 0.5),
            )
            embedding = await self.embedder.embed_one(f"{page.title}\n{page.abstract}\n{page.body[:2000]}") if self.embedder else None
            self.store.upsert_page(rel, page.kind, page.title, page.body, abstract=page.abstract, entities=page.entities or [], tags=page.tags or [], pinned=page.pinned, salience=page.salience, embedding=embedding)
            count += 1
        return count
