"""Local control channel — how the outside world talks to a *running* mind.

A tiny authenticated WebSocket JSON-RPC server bound to localhost. The MCP façade (`emeth mcp`) and the
dashboard are its clients. Every method goes through the same objects the cognitive loop uses (planner,
timeline, wiki, body client), so nothing done from outside is invisible to the agent: a goal set here shows
up in [GOALS], a message sent here is remembered as `mentor_in`, speech is logged as `said`.

Frames: request `{"id", "method", "params"}` → response `{"id", "ok": true, "result"}` or
`{"id", "ok": false, "error": {"code", "message"}}`. Authentication: `?token=` on the URL (same convention
as the body bridge). No method ever bypasses the body's rules (no commands, no teleport): `say` is chat.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlsplit

from emeth.cognition.planner import Task
from emeth.protocol import BodyError

if TYPE_CHECKING:
    from emeth.runtime import Mind

log = logging.getLogger(__name__)


class ControlError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True)
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    return value


class ControlAPI:
    """The methods. Pure dispatch over a Mind; usable without any socket (tests, dashboard in-process)."""

    def __init__(self, mind: Mind):
        self.mind = mind

    @property
    def _loop(self) -> Any:
        if self.mind.loop is None:
            raise ControlError("NOT_READY", "the mind is not running yet")
        return self.mind.loop

    async def dispatch(self, method: str, params: dict[str, Any] | None) -> Any:
        params = params or {}
        handler = getattr(self, f"m_{method}", None)
        if handler is None:
            raise ControlError("UNKNOWN_METHOD", f"unknown method {method!r}; known: {', '.join(self.methods())}")
        try:
            return _jsonable(await handler(**params))
        except TypeError as exc:
            raise ControlError("BAD_REQUEST", f"{method}: {exc}") from exc
        except BodyError as exc:
            raise ControlError(exc.code, exc.message) from exc

    @classmethod
    def methods(cls) -> list[str]:
        return sorted(n[2:] for n in dir(cls) if n.startswith("m_"))

    # --- introspection ---------------------------------------------------------------------
    async def m_status(self) -> dict[str, Any]:
        m = self.mind
        body = m.body
        out: dict[str, Any] = {
            "name": m.identity.name,
            "autonomy": {"level": m.identity.level.level, "stage": m.identity.level.name, "experience": round(m.identity.metrics.experience(), 1)},
            "body": {"connected": body.connected.is_set(), "minecraft": (body.hello.minecraft if body.hello else None), "actions": len(body.hello.actions) if body.hello else 0},
            "goals": m.planner.progress(),
            "drives": m.drives.state.__dict__,
            "router": m.router.health(),
        }
        if m.loop is not None:
            snap = m.loop.snapshot()
            out["stats"] = snap["stats"]
            out["last_result"] = snap["last_result"]
        obs = body.latest_observation
        if obs is not None:
            s = obs.self_
            out["self"] = {"position": s.position.model_dump(), "dimension": s.dimension, "health": s.health, "food": s.food, "day": obs.world.day, "phase": obs.world.phase}
        return out

    async def m_observe(self, detail: str = "compact") -> Any:
        if detail not in ("compact", "full"):
            raise ControlError("BAD_REQUEST", "detail must be compact|full")
        return await self.mind.body.observe(detail)

    async def m_render(self, width: int = 96, height: int = 54, fov_deg: float = 90, max_distance: float = 48) -> Any:
        width, height = max(8, min(256, int(width))), max(4, min(144, int(height)))
        return await self.mind.body.render(width=width, height=height, fov_deg=fov_deg, max_distance=max_distance)

    async def m_identity(self) -> dict[str, Any]:
        return {"text": self.mind.identity.render(), "persona": self.mind.persona.model_dump(mode="json")}

    async def m_goals(self) -> dict[str, Any]:
        return {"progress": self.mind.planner.progress(), "text": self.mind.planner.render(), "goals": [g.to_dict() for g in self.mind.planner.goals if g.status == "active"]}

    async def m_timeline(self, limit: int = 30, kinds: list[str] | None = None) -> list[dict[str, Any]]:
        limit = max(1, min(200, int(limit)))
        entries = self.mind.timeline.recent(limit=limit, kinds=set(kinds) if kinds else None)
        return [{"ts": e.ts, "kind": e.kind, "text": e.text, "count": e.count, "actors": e.actors} for e in entries]

    async def m_memory_search(self, query: str, limit: int = 8) -> dict[str, Any]:
        if not query.strip():
            raise ControlError("BAD_REQUEST", "query is empty")
        limit = max(1, min(30, int(limit)))
        pages = await self.mind.wiki.search(query, limit=limit)
        episodes = self.mind.store.search_episodes(query, limit=limit)
        return {
            "pages": [{"path": p.path, "kind": p.kind, "title": p.title, "abstract": p.abstract, "body": p.body[:1500]} for p in pages],
            "episodes": [{"ts": e.ts, "day": e.day, "kind": e.kind, "text": e.text, "importance": e.importance} for e in episodes],
        }

    async def m_skills(self) -> list[dict[str, Any]]:
        return [_jsonable(r) for r in self.mind.skills.records()]

    # --- influence (never commands: the agent remains the one deciding) ---------------------
    async def m_say(self, text: str, to: str | None = None) -> dict[str, Any]:
        text = text.strip()
        if not text:
            raise ControlError("BAD_REQUEST", "nothing to say")
        await self._loop.speak(text[:240], to)
        return {"said": text[:240], "to": to}

    async def m_tell(self, text: str, source: str = "mentor") -> dict[str, Any]:
        self._loop.hear_mentor(text, source=source[:40] or "mentor")
        return {"delivered": True, "wakes_next_thought": True}

    async def m_set_goal(self, title: str, why: str = "", priority: int = 4, tasks: list[str] | None = None, source: str = "mentor") -> dict[str, Any]:
        title = title.strip()
        if not title:
            raise ControlError("BAD_REQUEST", "goal title is empty")
        priority = max(1, min(9, int(priority)))
        task_list = [Task(description=t.strip(), kind="custom", source=source) for t in (tasks or [title]) if t.strip()]
        goal = self.mind.planner.add_goal(title[:200], task_list, why=why[:500], priority=priority, source=source)
        self.mind.timeline.add("plan", f"goal from {source}: {title}", importance=0.6)
        if self.mind.loop is not None:
            self.mind.loop.wake(f"goal from {source}")
        return {"goal": goal.to_dict()}

    async def m_abandon_goal(self, title: str) -> dict[str, Any]:
        ok = self.mind.planner.abandon_goal(title)
        if ok:
            self.mind.timeline.add("plan", f"goal abandoned on request: {title}", importance=0.4)
        return {"abandoned": ok}

    async def m_wake(self, reason: str = "control") -> dict[str, Any]:
        self._loop.wake(f"control:{reason[:60]}")
        return {"woken": True}


class ControlServer:
    """`websockets` server around ControlAPI. One token, localhost by default."""

    def __init__(self, api: ControlAPI, host: str = "127.0.0.1", port: int = 8766, token: str = ""):
        self.api = api
        self.host = host
        self.port = port
        self.token = token or secrets.token_urlsafe(24)
        self._server: Any = None

    @property
    def url(self) -> str:
        return f"ws://{self.host}:{self.port}"

    def write_token(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.token, encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:  # pragma: no cover - windows
            pass

    async def start(self) -> None:
        from websockets.asyncio.server import serve

        self._server = await serve(self._handle, self.host, self.port, max_size=16 * 1024 * 1024)
        # port 0 → learn the real one
        sockets = getattr(self._server, "sockets", None) or []
        if sockets:
            self.port = sockets[0].getsockname()[1]
        log.info("control channel listening on %s", self.url)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    def _authorized(self, path: str | None) -> bool:
        query = parse_qs(urlsplit(path or "").query)
        token = (query.get("token") or [""])[0]
        return secrets.compare_digest(token, self.token)

    async def _handle(self, ws: Any) -> None:
        path = getattr(getattr(ws, "request", None), "path", None)
        if not self._authorized(path):
            await ws.send(json.dumps({"id": None, "ok": False, "error": {"code": "UNAUTHORIZED", "message": "bad or missing token"}}))
            await ws.close(code=4401, reason="unauthorized")
            return
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send(json.dumps({"id": None, "ok": False, "error": {"code": "BAD_REQUEST", "message": "invalid JSON"}}))
                continue
            rid = msg.get("id") if isinstance(msg, dict) else None
            method = msg.get("method") if isinstance(msg, dict) else None
            params = msg.get("params") if isinstance(msg, dict) else None
            if not isinstance(method, str):
                await ws.send(json.dumps({"id": rid, "ok": False, "error": {"code": "BAD_REQUEST", "message": "missing method"}}))
                continue
            try:
                result = await self.api.dispatch(method, params if isinstance(params, dict) else None)
                await ws.send(json.dumps({"id": rid, "ok": True, "result": result}, default=str))
            except ControlError as exc:
                await ws.send(json.dumps({"id": rid, "ok": False, "error": {"code": exc.code, "message": exc.message}}))
            except Exception as exc:  # noqa: BLE001
                log.exception("control method %s failed", method)
                await ws.send(json.dumps({"id": rid, "ok": False, "error": {"code": "INTERNAL", "message": str(exc)[:300]}}))


class ControlClient:
    """Minimal client (used by the MCP façade and tests): one connection per call keeps it stateless and robust."""

    def __init__(self, url: str, token: str, timeout_s: float = 60.0):
        self.url = url
        self.token = token
        self.timeout_s = timeout_s

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        import websockets

        target = f"{self.url}{'&' if '?' in self.url else '?'}token={self.token}"
        try:
            async with websockets.connect(target, max_size=16 * 1024 * 1024, open_timeout=5) as ws:
                await ws.send(json.dumps({"id": "1", "method": method, "params": params or {}}))
                raw = await asyncio.wait_for(ws.recv(), timeout=self.timeout_s)
        except (TimeoutError, OSError) as exc:
            raise ControlError("UNREACHABLE", f"cannot reach the mind at {self.url}: {exc}. Is `emeth run` running?") from exc
        except Exception as exc:  # noqa: BLE001 - websockets' own exception tree
            if exc.__class__.__name__ in {"InvalidStatus", "InvalidURI", "ConnectionClosedError", "InvalidHandshake"} or "connect" in str(exc).lower():
                raise ControlError("UNREACHABLE", f"cannot reach the mind at {self.url}: {exc}") from exc
            raise
        msg = json.loads(raw)
        if not msg.get("ok"):
            err = msg.get("error") or {}
            raise ControlError(str(err.get("code", "ERROR")), str(err.get("message", "control call failed")))
        return msg.get("result")
