"""SQLite memory store — the index behind every memory layer.

Design (from ai-memory): markdown pages are the source of truth for semantic memory, SQLite is a
rebuildable index with FTS5 + vector columns; a single writer (this object, called from the loop's
thread) keeps `database is locked` away. Retention follows ai-memory's decay formula.
"""

from __future__ import annotations

import json
import math
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  day INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.3,
  dimension TEXT,
  x REAL, y REAL, z REAL,
  actors TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  consolidated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(ts);
CREATE INDEX IF NOT EXISTS idx_episodes_day ON episodes(day);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(text, content='episodes', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  entities TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  last_accessed_at REAL,
  access_count INTEGER NOT NULL DEFAULT 0,
  salience REAL NOT NULL DEFAULT 0.5,
  expires_at REAL,
  embedding BLOB
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, body, content='pages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
  INSERT INTO pages_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TABLE IF NOT EXISTS people (
  username TEXT PRIMARY KEY,
  first_seen REAL NOT NULL,
  last_seen REAL NOT NULL,
  trust REAL NOT NULL DEFAULT 0.5,
  mood TEXT NOT NULL DEFAULT 'neutral',
  interactions INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '[]',
  promises TEXT NOT NULL DEFAULT '[]',
  relationship TEXT NOT NULL DEFAULT 'stranger'
);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  dimension TEXT NOT NULL DEFAULT 'overworld',
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  radius REAL NOT NULL DEFAULT 4,
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at REAL NOT NULL,
  last_visit REAL,
  visits INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, dimension)
);
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  avg_ms REAL NOT NULL DEFAULT 0,
  embedding BLOB
);
"""


def _pack(vec: list[float] | None) -> bytes | None:
    if vec is None:
        return None
    return np.asarray(vec, dtype=np.float32).tobytes()


def _unpack(blob: bytes | None) -> list[float] | None:
    if blob is None:
        return None
    return np.frombuffer(blob, dtype=np.float32).tolist()


@dataclass
class Episode:
    id: int
    ts: float
    day: int
    kind: str
    text: str
    importance: float
    dimension: str | None = None
    pos: tuple[float, float, float] | None = None
    actors: list[str] = field(default_factory=list)


@dataclass
class Page:
    id: int
    path: str
    kind: str
    title: str
    abstract: str
    body: str
    entities: list[str]
    tags: list[str]
    pinned: bool
    created_at: float
    updated_at: float
    salience: float
    access_count: int = 0
    last_accessed_at: float | None = None
    expires_at: float | None = None
    score: float = 0.0


@dataclass
class Person:
    username: str
    first_seen: float
    last_seen: float
    trust: float
    mood: str
    interactions: int
    notes: list[str]
    promises: list[str]
    relationship: str


@dataclass
class Place:
    id: int
    name: str
    kind: str
    dimension: str
    x: float
    y: float
    z: float
    radius: float
    notes: str
    tags: list[str]
    visits: int
    last_visit: float | None

    def distance_to(self, x: float, y: float, z: float) -> float:
        return math.sqrt((self.x - x) ** 2 + (self.y - y) ** 2 + (self.z - z) ** 2)


@dataclass
class SkillRecord:
    name: str
    path: str
    description: str
    tags: list[str]
    version: int
    uses: int
    successes: int
    failures: int
    avg_ms: float
    embedding: list[float] | None = None
    score: float = 0.0

    @property
    def success_rate(self) -> float:
        total = self.successes + self.failures
        return self.successes / total if total else 0.5


def retention(salience: float, age_days: float, access_count: int, days_since_access: float, actors: int = 1, lam: float = 0.02, sigma: float = 0.6, mu: float = 0.04, breadth: float = 0.3) -> float:
    """ai-memory retention: salience·e^(−λΔt) + σ·log(1+access)·e^(−μ·days_since_access)·(1+β·ln(1+max(actors−1,0)))."""
    recency = salience * math.exp(-lam * age_days)
    usage = sigma * math.log1p(access_count) * math.exp(-mu * days_since_access) * (1 + breadth * math.log1p(max(actors - 1, 0)))
    return recency + usage


class MemoryStore:
    def __init__(self, path: Path | str = ":memory:"):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ---- key/value -------------------------------------------------------------------------
    def get(self, key: str, default: Any = None) -> Any:
        row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set(self, key: str, value: Any) -> None:
        self.conn.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value, ensure_ascii=False)))
        self.conn.commit()

    def incr(self, key: str, by: float = 1) -> float:
        value = float(self.get(key, 0)) + by
        self.set(key, value)
        return value

    # ---- episodes --------------------------------------------------------------------------
    def add_episode(self, kind: str, text: str, *, ts: float | None = None, day: int = 0, importance: float = 0.3, dimension: str | None = None, pos: tuple[float, float, float] | None = None, actors: list[str] | None = None, embedding: list[float] | None = None) -> int:
        cur = self.conn.execute(
            "INSERT INTO episodes(ts,day,kind,text,importance,dimension,x,y,z,actors,embedding) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (ts or time.time(), day, kind, text, importance, dimension, *(pos or (None, None, None)), json.dumps(actors or []), _pack(embedding)),
        )
        self.conn.commit()
        return int(cur.lastrowid or 0)

    def _row_episode(self, r: sqlite3.Row) -> Episode:
        pos = (r["x"], r["y"], r["z"]) if r["x"] is not None else None
        return Episode(id=r["id"], ts=r["ts"], day=r["day"], kind=r["kind"], text=r["text"], importance=r["importance"], dimension=r["dimension"], pos=pos, actors=json.loads(r["actors"]))

    def recent_episodes(self, limit: int = 50, since_ts: float | None = None, kinds: list[str] | None = None) -> list[Episode]:
        sql = "SELECT * FROM episodes WHERE 1=1"
        args: list[Any] = []
        if since_ts is not None:
            sql += " AND ts >= ?"
            args.append(since_ts)
        if kinds:
            sql += f" AND kind IN ({','.join('?' * len(kinds))})"
            args.extend(kinds)
        sql += " ORDER BY ts DESC LIMIT ?"
        args.append(limit)
        rows = self.conn.execute(sql, args).fetchall()
        return [self._row_episode(r) for r in reversed(rows)]

    def episodes_for_day(self, day: int) -> list[Episode]:
        rows = self.conn.execute("SELECT * FROM episodes WHERE day=? ORDER BY ts", (day,)).fetchall()
        return [self._row_episode(r) for r in rows]

    def unconsolidated_episodes(self, limit: int = 500) -> list[Episode]:
        rows = self.conn.execute("SELECT * FROM episodes WHERE consolidated=0 ORDER BY ts LIMIT ?", (limit,)).fetchall()
        return [self._row_episode(r) for r in rows]

    def mark_consolidated(self, ids: list[int]) -> None:
        if not ids:
            return
        self.conn.execute(f"UPDATE episodes SET consolidated=1 WHERE id IN ({','.join('?' * len(ids))})", ids)
        self.conn.commit()

    def search_episodes(self, query: str, limit: int = 20) -> list[Episode]:
        q = _fts_query(query)
        if not q:
            return []
        rows = self.conn.execute(
            "SELECT e.* FROM episodes_fts f JOIN episodes e ON e.id = f.rowid WHERE episodes_fts MATCH ? ORDER BY bm25(episodes_fts) LIMIT ?",
            (q, limit),
        ).fetchall()
        return [self._row_episode(r) for r in rows]

    def count_episodes(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) FROM episodes").fetchone()[0])

    # ---- pages -----------------------------------------------------------------------------
    def upsert_page(self, path: str, kind: str, title: str, body: str, *, abstract: str = "", entities: list[str] | None = None, tags: list[str] | None = None, pinned: bool = False, salience: float = 0.5, expires_at: float | None = None, embedding: list[float] | None = None) -> int:
        now = time.time()
        existing = self.conn.execute("SELECT id FROM pages WHERE path=?", (path,)).fetchone()
        if existing:
            self.conn.execute(
                "UPDATE pages SET kind=?, title=?, abstract=?, body=?, entities=?, tags=?, pinned=?, updated_at=?, salience=MAX(salience, ?), expires_at=?, embedding=COALESCE(?, embedding) WHERE id=?",
                (kind, title, abstract, body, json.dumps(entities or []), json.dumps(tags or []), int(pinned), now, salience, expires_at, _pack(embedding), existing["id"]),
            )
            self.conn.commit()
            return int(existing["id"])
        cur = self.conn.execute(
            "INSERT INTO pages(path,kind,title,abstract,body,entities,tags,pinned,created_at,updated_at,salience,expires_at,embedding) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (path, kind, title, abstract, body, json.dumps(entities or []), json.dumps(tags or []), int(pinned), now, now, salience, expires_at, _pack(embedding)),
        )
        self.conn.commit()
        return int(cur.lastrowid or 0)

    def _row_page(self, r: sqlite3.Row) -> Page:
        return Page(
            id=r["id"], path=r["path"], kind=r["kind"], title=r["title"], abstract=r["abstract"], body=r["body"],
            entities=json.loads(r["entities"]), tags=json.loads(r["tags"]), pinned=bool(r["pinned"]), created_at=r["created_at"],
            updated_at=r["updated_at"], salience=r["salience"], access_count=r["access_count"], last_accessed_at=r["last_accessed_at"], expires_at=r["expires_at"],
        )

    def get_page(self, path: str) -> Page | None:
        r = self.conn.execute("SELECT * FROM pages WHERE path=?", (path,)).fetchone()
        return self._row_page(r) if r else None

    def list_pages(self, kind: str | None = None, limit: int = 200) -> list[Page]:
        if kind:
            rows = self.conn.execute("SELECT * FROM pages WHERE kind=? ORDER BY updated_at DESC LIMIT ?", (kind, limit)).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM pages ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
        return [self._row_page(r) for r in rows]

    def delete_page(self, path: str) -> None:
        self.conn.execute("DELETE FROM pages WHERE path=?", (path,))
        self.conn.commit()

    def touch_page(self, page_id: int) -> None:
        self.conn.execute("UPDATE pages SET access_count=access_count+1, last_accessed_at=? WHERE id=?", (time.time(), page_id))
        self.conn.commit()

    def search_pages(self, query: str, embedding: list[float] | None = None, limit: int = 8, kinds: list[str] | None = None) -> list[Page]:
        """Reciprocal-rank fusion of FTS5 (bm25) and vector similarity, with an authority multiplier."""
        ranks: dict[int, float] = {}
        k = 60.0
        q = _fts_query(query)
        if q:
            sql = "SELECT p.id FROM pages_fts f JOIN pages p ON p.id=f.rowid WHERE pages_fts MATCH ?"
            args: list[Any] = [q]
            if kinds:
                sql += f" AND p.kind IN ({','.join('?' * len(kinds))})"
                args.extend(kinds)
            sql += " ORDER BY bm25(pages_fts) LIMIT 40"
            for rank, row in enumerate(self.conn.execute(sql, args).fetchall()):
                ranks[row["id"]] = ranks.get(row["id"], 0.0) + 1.0 / (k + rank)
        if embedding is not None:
            sql = "SELECT id, embedding FROM pages WHERE embedding IS NOT NULL"
            args = []
            if kinds:
                sql += f" AND kind IN ({','.join('?' * len(kinds))})"
                args.extend(kinds)
            sims: list[tuple[float, int]] = []
            qv = np.asarray(embedding, dtype=np.float32)
            for row in self.conn.execute(sql, args).fetchall():
                v = np.frombuffer(row["embedding"], dtype=np.float32)
                if v.shape != qv.shape:
                    continue
                sims.append((float(np.dot(v, qv)), row["id"]))
            sims.sort(reverse=True)
            for rank, (sim, pid) in enumerate(sims[:40]):
                if sim < 0.15:
                    break
                ranks[pid] = ranks.get(pid, 0.0) + 1.0 / (k + rank)
        if not ranks:
            return []
        ids = list(ranks.keys())
        rows = self.conn.execute(f"SELECT * FROM pages WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall()
        pages = []
        for r in rows:
            p = self._row_page(r)
            authority = 1.0 + (0.5 if p.pinned else 0.0) + (0.2 if "canonical" in p.tags else 0.0) - (0.6 if "superseded" in p.tags else 0.0)
            p.score = ranks[p.id] * authority * (0.5 + p.salience)
            pages.append(p)
        pages.sort(key=lambda p: p.score, reverse=True)
        return pages[:limit]

    def sweep_pages(self, now: float | None = None, cold_threshold: float = 0.2, hard_delete_after_days: float = 180) -> dict[str, int]:
        """Expire / archive pages according to the retention formula. Pinned pages are exempt."""
        now = now or time.time()
        expired = archived = deleted = 0
        for p in self.list_pages(limit=100_000):
            if p.pinned:
                continue
            if p.expires_at and p.expires_at < now:
                self.delete_page(p.path)
                expired += 1
                continue
            age_days = (now - p.created_at) / 86400
            since_access = (now - (p.last_accessed_at or p.updated_at)) / 86400
            score = retention(p.salience, age_days, p.access_count, since_access, actors=max(1, len(p.entities)))
            if score < cold_threshold:
                if age_days > hard_delete_after_days:
                    self.delete_page(p.path)
                    deleted += 1
                elif "cold" not in p.tags:
                    tags = p.tags + ["cold"]
                    self.conn.execute("UPDATE pages SET tags=? WHERE id=?", (json.dumps(tags), p.id))
                    archived += 1
        self.conn.commit()
        return {"expired": expired, "archived": archived, "deleted": deleted}

    # ---- people ----------------------------------------------------------------------------
    def get_person(self, username: str) -> Person | None:
        r = self.conn.execute("SELECT * FROM people WHERE username=?", (username,)).fetchone()
        if not r:
            return None
        return Person(username=r["username"], first_seen=r["first_seen"], last_seen=r["last_seen"], trust=r["trust"], mood=r["mood"], interactions=r["interactions"], notes=json.loads(r["notes"]), promises=json.loads(r["promises"]), relationship=r["relationship"])

    def upsert_person(self, username: str, *, trust: float | None = None, mood: str | None = None, note: str | None = None, promise: str | None = None, relationship: str | None = None, interaction: bool = False) -> Person:
        now = time.time()
        p = self.get_person(username)
        if p is None:
            self.conn.execute("INSERT INTO people(username, first_seen, last_seen) VALUES(?,?,?)", (username, now, now))
            p = self.get_person(username)
            assert p is not None
        notes = p.notes
        if note:
            notes = (notes + [note])[-12:]
        promises = p.promises
        if promise:
            promises = (promises + [promise])[-8:]
        self.conn.execute(
            "UPDATE people SET last_seen=?, trust=?, mood=?, interactions=?, notes=?, promises=?, relationship=? WHERE username=?",
            (now, max(0.0, min(1.0, trust if trust is not None else p.trust)), mood or p.mood, p.interactions + (1 if interaction else 0), json.dumps(notes, ensure_ascii=False), json.dumps(promises, ensure_ascii=False), relationship or p.relationship, username),
        )
        self.conn.commit()
        res = self.get_person(username)
        assert res is not None
        return res

    def list_people(self, limit: int = 50) -> list[Person]:
        rows = self.conn.execute("SELECT username FROM people ORDER BY last_seen DESC LIMIT ?", (limit,)).fetchall()
        return [p for p in (self.get_person(r["username"]) for r in rows) if p]

    # ---- places ----------------------------------------------------------------------------
    def upsert_place(self, name: str, kind: str, x: float, y: float, z: float, *, dimension: str = "overworld", radius: float = 4, notes: str = "", tags: list[str] | None = None, visit: bool = False) -> Place:
        now = time.time()
        r = self.conn.execute("SELECT * FROM places WHERE name=? AND dimension=?", (name, dimension)).fetchone()
        if r:
            self.conn.execute(
                "UPDATE places SET kind=?, x=?, y=?, z=?, radius=?, notes=CASE WHEN ?='' THEN notes ELSE ? END, tags=?, last_visit=CASE WHEN ? THEN ? ELSE last_visit END, visits=visits+? WHERE id=?",
                (kind, x, y, z, radius, notes, notes, json.dumps(tags or json.loads(r["tags"])), int(visit), now, int(visit), r["id"]),
            )
        else:
            self.conn.execute(
                "INSERT INTO places(name,kind,dimension,x,y,z,radius,notes,tags,created_at,last_visit,visits) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (name, kind, dimension, x, y, z, radius, notes, json.dumps(tags or []), now, now if visit else None, int(visit)),
            )
        self.conn.commit()
        row = self.conn.execute("SELECT * FROM places WHERE name=? AND dimension=?", (name, dimension)).fetchone()
        return self._row_place(row)

    def _row_place(self, r: sqlite3.Row) -> Place:
        return Place(id=r["id"], name=r["name"], kind=r["kind"], dimension=r["dimension"], x=r["x"], y=r["y"], z=r["z"], radius=r["radius"], notes=r["notes"], tags=json.loads(r["tags"]), visits=r["visits"], last_visit=r["last_visit"])

    def list_places(self, dimension: str | None = None, kind: str | None = None) -> list[Place]:
        sql = "SELECT * FROM places WHERE 1=1"
        args: list[Any] = []
        if dimension:
            sql += " AND dimension=?"
            args.append(dimension)
        if kind:
            sql += " AND kind=?"
            args.append(kind)
        return [self._row_place(r) for r in self.conn.execute(sql + " ORDER BY created_at", args).fetchall()]

    def nearest_places(self, x: float, y: float, z: float, dimension: str = "overworld", limit: int = 5, kind: str | None = None) -> list[Place]:
        places = self.list_places(dimension, kind)
        places.sort(key=lambda p: p.distance_to(x, y, z))
        return places[:limit]

    def delete_place(self, name: str, dimension: str = "overworld") -> None:
        self.conn.execute("DELETE FROM places WHERE name=? AND dimension=?", (name, dimension))
        self.conn.commit()

    # ---- skills ----------------------------------------------------------------------------
    def upsert_skill(self, name: str, path: str, description: str, *, tags: list[str] | None = None, embedding: list[float] | None = None, bump_version: bool = False) -> SkillRecord:
        now = time.time()
        r = self.conn.execute("SELECT * FROM skills WHERE name=?", (name,)).fetchone()
        if r:
            self.conn.execute(
                "UPDATE skills SET path=?, description=?, tags=?, updated_at=?, version=version+?, embedding=COALESCE(?, embedding) WHERE name=?",
                (path, description, json.dumps(tags or json.loads(r["tags"])), now, int(bump_version), _pack(embedding), name),
            )
        else:
            self.conn.execute(
                "INSERT INTO skills(name,path,description,tags,created_at,updated_at,embedding) VALUES(?,?,?,?,?,?,?)",
                (name, path, description, json.dumps(tags or []), now, now, _pack(embedding)),
            )
        self.conn.commit()
        rec = self.get_skill(name)
        assert rec is not None
        return rec

    def _row_skill(self, r: sqlite3.Row) -> SkillRecord:
        return SkillRecord(name=r["name"], path=r["path"], description=r["description"], tags=json.loads(r["tags"]), version=r["version"], uses=r["uses"], successes=r["successes"], failures=r["failures"], avg_ms=r["avg_ms"], embedding=_unpack(r["embedding"]))

    def get_skill(self, name: str) -> SkillRecord | None:
        r = self.conn.execute("SELECT * FROM skills WHERE name=?", (name,)).fetchone()
        return self._row_skill(r) if r else None

    def list_skills(self) -> list[SkillRecord]:
        return [self._row_skill(r) for r in self.conn.execute("SELECT * FROM skills ORDER BY name").fetchall()]

    def record_skill_outcome(self, name: str, ok: bool, ms: float) -> None:
        r = self.conn.execute("SELECT uses, avg_ms FROM skills WHERE name=?", (name,)).fetchone()
        if not r:
            return
        uses = r["uses"] + 1
        avg = (r["avg_ms"] * r["uses"] + ms) / uses
        self.conn.execute(
            "UPDATE skills SET uses=?, successes=successes+?, failures=failures+?, avg_ms=?, updated_at=? WHERE name=?",
            (uses, int(ok), int(not ok), avg, time.time(), name),
        )
        self.conn.commit()

    def delete_skill(self, name: str) -> None:
        self.conn.execute("DELETE FROM skills WHERE name=?", (name,))
        self.conn.commit()

    def search_skills(self, embedding: list[float], limit: int = 5, min_sim: float = 0.2) -> list[SkillRecord]:
        qv = np.asarray(embedding, dtype=np.float32)
        out: list[SkillRecord] = []
        for rec in self.list_skills():
            if rec.embedding is None or len(rec.embedding) != len(qv):
                continue
            sim = float(np.dot(np.asarray(rec.embedding, dtype=np.float32), qv))
            if sim >= min_sim:
                rec.score = sim * (0.6 + 0.4 * rec.success_rate)
                out.append(rec)
        out.sort(key=lambda r: r.score, reverse=True)
        return out[:limit]


def _fts_query(query: str) -> str:
    """Turn free text into a safe FTS5 query: quoted OR-ed terms."""
    import re

    terms = [t for t in re.findall(r"[\w]+", query.lower()) if len(t) > 1]
    if not terms:
        return ""
    return " OR ".join(f'"{t}"' for t in terms[:12])
