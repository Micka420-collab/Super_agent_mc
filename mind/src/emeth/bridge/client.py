"""Async WebSocket client for the body bridge.

Request/response correlation, an event queue for the cognitive loop, automatic reconnection, and
typed helpers for the common calls. Pure asyncio; the transport is injectable so unit tests can run
against an in-process fake body (see tests/fakes.py).
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from emeth.protocol import (
    ActionResult,
    BodyError,
    HelloResult,
    Observation,
    ReflexConfig,
    RenderResult,
    SkillCheckResult,
    SkillRunResult,
)

log = logging.getLogger(__name__)


@dataclass
class BodyEvent:
    event: str
    ts: float
    payload: Any


class Transport:
    """Minimal interface the client needs from a socket-like object."""

    async def send(self, text: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def __aiter__(self) -> AsyncIterator[str]:  # pragma: no cover - interface
        raise NotImplementedError

    async def close(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError


TransportFactory = Callable[[], Awaitable[Transport]]


class WebsocketTransport(Transport):
    def __init__(self, ws: Any):
        self._ws = ws

    async def send(self, text: str) -> None:
        await self._ws.send(text)

    def __aiter__(self) -> AsyncIterator[str]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[str]:
        async for msg in self._ws:
            yield msg if isinstance(msg, str) else msg.decode("utf-8")

    async def close(self) -> None:
        await self._ws.close()


def websocket_factory(url: str, token: str = "") -> TransportFactory:
    async def connect() -> Transport:
        import websockets

        target = url
        if token:
            sep = "&" if "?" in url else "?"
            target = f"{url}{sep}token={token}"
        ws = await websockets.connect(target, max_size=32 * 1024 * 1024, ping_interval=20, ping_timeout=20)
        return WebsocketTransport(ws)

    return connect


@dataclass
class BodyClient:
    """Talks to one body. `events` yields world events; `request` performs RPCs."""

    factory: TransportFactory
    reconnect_delay_s: float = 3.0
    request_timeout_s: float = 600.0
    events: asyncio.Queue[BodyEvent] = field(default_factory=lambda: asyncio.Queue(maxsize=2000))
    latest_observation: Observation | None = None
    hello: HelloResult | None = None
    _transport: Transport | None = None
    _pending: dict[str, asyncio.Future[Any]] = field(default_factory=dict)
    _reader: asyncio.Task[None] | None = None
    _closed: bool = False
    connected: asyncio.Event = field(default_factory=asyncio.Event)

    async def connect(self) -> None:
        self._closed = False
        self._transport = await self.factory()
        self.connected.set()
        self._reader = asyncio.create_task(self._read_loop(), name="body-reader")
        hello = await self.request("hello")
        self.hello = HelloResult.model_validate(hello)
        log.info("connected to body %s (mc %s) with %d actions", self.hello.body.get("version"), self.hello.minecraft.get("version"), len(self.hello.actions))

    async def close(self) -> None:
        self._closed = True
        if self._reader:
            self._reader.cancel()
        if self._transport:
            await self._transport.close()
        self.connected.clear()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("client closed"))
        self._pending.clear()

    async def _read_loop(self) -> None:
        assert self._transport is not None
        try:
            async for raw in self._transport:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("non-JSON frame from body: %.80s", raw)
                    continue
                kind = msg.get("kind")
                if kind == "response":
                    fut = self._pending.pop(msg.get("id", ""), None)
                    if fut is None or fut.done():
                        continue
                    if msg.get("ok"):
                        fut.set_result(msg.get("result"))
                    else:
                        err = msg.get("error") or {}
                        fut.set_exception(BodyError(err.get("code", "INTERNAL"), err.get("message", "unknown error"), err.get("data")))
                elif kind == "event":
                    ev = BodyEvent(event=msg.get("event", "?"), ts=msg.get("ts", 0), payload=msg.get("payload"))
                    if ev.event == "observation":
                        try:
                            self.latest_observation = Observation.model_validate(ev.payload)
                        except Exception as exc:  # noqa: BLE001
                            log.debug("observation parse failed: %s", exc)
                        continue  # observations are polled, not queued
                    if self.events.full():
                        _ = self.events.get_nowait()  # drop the oldest
                    self.events.put_nowait(ev)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("body connection lost: %s", exc)
        finally:
            self.connected.clear()
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(ConnectionError("body disconnected"))
            self._pending.clear()
            if not self._closed:
                self.events.put_nowait(BodyEvent(event="disconnected", ts=0, payload={"reason": "transport closed"}))
                asyncio.create_task(self._reconnect(), name="body-reconnect")

    async def _reconnect(self) -> None:
        delay = self.reconnect_delay_s
        while not self._closed:
            await asyncio.sleep(delay)
            try:
                await self.connect()
                self.events.put_nowait(BodyEvent(event="reconnected", ts=0, payload={}))
                return
            except Exception as exc:  # noqa: BLE001
                log.warning("reconnect failed: %s", exc)
                delay = min(delay * 2, 60)

    # ------------------------------------------------------------------------------------------
    async def request(self, method: str, params: Any = None, timeout_s: float | None = None) -> Any:
        if self._transport is None or not self.connected.is_set():
            raise ConnectionError("not connected to the body")
        rid = uuid.uuid4().hex
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await self._transport.send(json.dumps({"kind": "request", "id": rid, "method": method, "params": params}))
        try:
            return await asyncio.wait_for(fut, timeout_s or self.request_timeout_s)
        except TimeoutError:
            self._pending.pop(rid, None)
            raise BodyError("TIMEOUT", f"{method} timed out after {timeout_s or self.request_timeout_s}s") from None

    # Typed helpers --------------------------------------------------------------------------
    async def observe(self, detail: str = "compact") -> Observation:
        obs = Observation.model_validate(await self.request("observe", {"detail": detail}, timeout_s=20))
        self.latest_observation = obs
        return obs

    async def act(self, action: str, args: dict[str, Any] | None = None, timeout_ms: int | None = None) -> ActionResult:
        params: dict[str, Any] = {"action": action, "args": args or {}}
        if timeout_ms:
            params["timeoutMs"] = timeout_ms
        return ActionResult.model_validate(await self.request("act", params, timeout_s=(timeout_ms or 180_000) / 1000 + 30))

    async def run_skill(self, name: str, code: str, args: dict[str, Any] | None = None, timeout_ms: int = 120_000) -> SkillRunResult:
        params = {"name": name, "code": code, "args": args or {}, "timeoutMs": timeout_ms}
        return judge_skill_result(SkillRunResult.model_validate(await self.request("skill.run", params, timeout_s=timeout_ms / 1000 + 30)))

    async def check_skill(self, code: str) -> SkillCheckResult:
        return SkillCheckResult.model_validate(await self.request("skill.check", {"code": code}, timeout_s=20))

    async def chat(self, text: str, to: str | None = None) -> None:
        params: dict[str, Any] = {"text": text}
        if to:
            params["to"] = to
        await self.request("chat", params, timeout_s=20)

    async def stop(self) -> ActionResult:
        return ActionResult.model_validate(await self.request("stop", None, timeout_s=20))

    async def configure_reflexes(self, **partial: Any) -> ReflexConfig:
        return ReflexConfig.model_validate(await self.request("reflex.configure", partial, timeout_s=20))

    async def configure_stream(self, hz: float = 1.0, detail: str = "compact") -> None:
        await self.request("stream.configure", {"observationHz": hz, "detail": detail}, timeout_s=20)

    async def render(self, width: int = 96, height: int = 54, fov_deg: float = 90, max_distance: float = 48) -> RenderResult:
        params = {"width": width, "height": height, "fovDeg": fov_deg, "maxDistance": max_distance}
        return RenderResult.model_validate(await self.request("vision.render", params, timeout_s=30))

    async def find(self, names: list[str], max_distance: float = 64, count: int = 16) -> list[dict[str, Any]]:
        res = await self.request("world.find", {"names": names, "maxDistance": max_distance, "count": count}, timeout_s=20)
        return list(res.get("blocks", []))

    async def region(self, mn: tuple[int, int, int], mx: tuple[int, int, int], skip_air: bool = True) -> list[dict[str, Any]]:
        params = {"min": dict(zip("xyz", mn, strict=True)), "max": dict(zip("xyz", mx, strict=True)), "skipAir": skip_air}
        res = await self.request("world.region", params, timeout_s=60)
        return list(res.get("blocks", []))

    @property
    def action_names(self) -> set[str]:
        return {a.name for a in self.hello.actions} if self.hello else set()


# Flags a program uses to say how it went. A run that returns without throwing but reports one of them as false
# failed by its own account (seen live: `{"sealed": false}` stored as a verified shelter skill).
SELF_REPORT_FLAGS = ("ok", "success", "succeeded", "done", "complete", "completed", "sealed", "reached", "found")


# Primitives that only look: a program whose every successful call is one of these changed nothing in the world.
READ_ONLY_CALLS = frozenset({"observe", "block_at", "find_blocks", "scan_region", "surface_height", "players", "ore_info", "plan_get", "plan_build", "recipes", "inventory", "container_view", "look", "look_at", "look_at_player", "wait"})


def judge_skill_result(res: SkillRunResult) -> SkillRunResult:
    if not res.ok:
        return res
    acted = [t.call for t in res.trace if t.ok and t.call.split("(")[0] not in READ_ONLY_CALLS]
    if not acted:
        # seen live: two "escape" programs reported success while the agent had not moved a block
        failed = [t.call for t in res.trace if not t.ok]
        why = f"every action it tried failed ({', '.join(failed[:4])})" if failed else "it only looked around"
        return res.model_copy(update={"ok": False, "errorCode": "NO_EFFECT", "error": f"the program changed nothing in the world: {why}"})
    if not isinstance(res.result, dict):
        return res
    false_flags = [k for k in SELF_REPORT_FLAGS if res.result.get(k) is False]
    if not false_flags:
        return res
    return res.model_copy(update={"ok": False, "errorCode": "SELF_REPORTED_FAILURE", "error": f"the program itself reported {', '.join(f'{k}=false' for k in false_flags)}: {str(res.result)[:200]}"})

