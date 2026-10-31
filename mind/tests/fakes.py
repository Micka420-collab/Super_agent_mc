"""Test doubles: an in-process fake body speaking the wire protocol, and observation builders."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from emeth.bridge.client import Transport
from emeth.protocol import Observation

FIXTURES = Path(__file__).resolve().parents[2] / "protocol" / "fixtures"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def sample_observation(**overrides: Any) -> Observation:
    data = load_fixture("observation.json")
    data.update(overrides)
    return Observation.model_validate(data)


class FakeBodyTransport(Transport):
    """Behaves like the body's bridge: answers requests, lets tests inject events."""

    def __init__(self, world: FakeWorld):
        self.world = world
        self.incoming: asyncio.Queue[str | None] = asyncio.Queue()
        self.sent: list[dict[str, Any]] = []
        self.closed = False

    async def send(self, text: str) -> None:
        msg = json.loads(text)
        self.sent.append(msg)
        response = await self.world.handle(msg)
        await self.incoming.put(json.dumps(response))

    def __aiter__(self) -> AsyncIterator[str]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[str]:
        while True:
            item = await self.incoming.get()
            if item is None:
                return
            yield item

    async def close(self) -> None:
        self.closed = True
        await self.incoming.put(None)

    async def emit(self, event: str, payload: Any) -> None:
        await self.incoming.put(json.dumps({"kind": "event", "event": event, "ts": time.time() * 1000, "payload": payload}))


class FakeWorld:
    """Scriptable world state + action handlers."""

    def __init__(self) -> None:
        self.observation: dict[str, Any] = load_fixture("observation.json")
        self.hello: dict[str, Any] = load_fixture("hello.json")
        self.actions: list[tuple[str, dict[str, Any]]] = []
        self.chats: list[tuple[str, str | None]] = []
        self.skill_runs: list[dict[str, Any]] = []
        self.skill_response: dict[str, Any] | None = None
        self.action_handler = None
        self.action_delay_s = 0.0
        self.reflex_config: dict[str, Any] = {}

    def set_inventory(self, items: dict[str, int]) -> None:
        self.observation["inventory"]["items"] = [{"name": n, "count": c, "slot": 9 + i} for i, (n, c) in enumerate(items.items())]
        self.observation["inventory"]["freeSlots"] = 36 - len(items)

    def add_inventory(self, name: str, count: int) -> None:
        inv = self.observation["inventory"]["items"]
        for it in inv:
            if it["name"] == name:
                it["count"] += count
                return
        inv.append({"name": name, "count": count, "slot": 9 + len(inv)})

    async def handle(self, msg: dict[str, Any]) -> dict[str, Any]:
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        ok = lambda result: {"kind": "response", "id": rid, "ok": True, "result": result}  # noqa: E731
        err = lambda code, message: {"kind": "response", "id": rid, "ok": False, "error": {"code": code, "message": message}}  # noqa: E731
        if method == "hello":
            return ok(self.hello)
        if method == "observe":
            self.observation["ts"] = time.time() * 1000
            return ok(self.observation)
        if method == "act":
            name, args = params.get("action"), params.get("args") or {}
            self.actions.append((name, args))
            if self.action_delay_s:
                await asyncio.sleep(self.action_delay_s)
            if name not in {a["name"] for a in self.hello["actions"]}:
                return err("UNKNOWN_ACTION", f"unknown action: {name}")
            result: Any = {"done": True}
            if self.action_handler:
                outcome = self.action_handler(name, args, self)
                if isinstance(outcome, Exception):
                    return err("INTERNAL", str(outcome))
                if isinstance(outcome, dict) and outcome.get("__error__"):
                    return ok({"id": "a1", "action": name, "ok": False, "error": outcome["__error__"], "errorCode": outcome.get("code", "INTERNAL"), "startedAt": time.time() * 1000 - 50, "finishedAt": time.time() * 1000})
                result = outcome
            return ok({"id": "a1", "action": name, "ok": True, "result": result, "startedAt": time.time() * 1000 - 50, "finishedAt": time.time() * 1000})
        if method == "skill.check":
            code = params.get("code", "")
            problems = [] if "async function main" in code and "process" not in code else ["skill must define `async function main(api, args)`"]
            return ok({"ok": not problems, "problems": problems, "apiCalls": []})
        if method == "skill.run":
            self.skill_runs.append(params)
            base = {"id": "s1", "name": params.get("name"), "ok": True, "result": {"done": True}, "logs": [], "trace": [{"t": 1, "call": "observe", "ok": True, "ms": 2}, {"t": 3, "call": "mine", "ok": True, "ms": 40}], "startedAt": time.time() * 1000 - 100, "finishedAt": time.time() * 1000}
            if self.skill_response:
                base.update(self.skill_response)
            return ok(base)
        if method == "chat":
            self.chats.append((params.get("text"), params.get("to")))
            return ok({"sent": 1})
        if method == "stop":
            return ok({"id": "stop", "action": "stop", "ok": True, "result": {"stopped": True}, "startedAt": 0, "finishedAt": 1})
        if method == "reflex.configure":
            self.reflex_config.update(params)
            return ok({**{"enabled": True}, **params})
        if method == "stream.configure":
            return ok(params)
        if method == "vision.render":
            return ok({"width": 8, "height": 4, "pngBase64": "iVBORw0KGgo=", "legend": {"#808080": "stone"}, "description": "stone everywhere", "source": "retina"})
        if method == "world.find":
            return ok({"blocks": []})
        if method == "world.region":
            return ok({"min": params.get("min"), "max": params.get("max"), "blocks": []})
        return err("UNKNOWN_METHOD", f"unknown method {method}")


def fake_transport_factory(world: FakeWorld):
    holder: dict[str, FakeBodyTransport] = {}

    async def factory() -> Transport:
        t = FakeBodyTransport(world)
        holder["transport"] = t
        return t

    factory.holder = holder  # type: ignore[attr-defined]
    return factory
