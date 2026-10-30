"""MCP façade — EMETH as a tool server for Claude Code, Claude Desktop, Codex or any MCP client.

Transport: stdio, newline-delimited JSON-RPC 2.0, the Model Context Protocol subset a *tools-only* server
needs (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`). Hand-written on
purpose (see ADR 0006): a few dozen lines, no dependency, and the subset has been stable across protocol
revisions 2024-11-05 → 2025-06-18.

The tools never command the agent. They let an outside mind *look* (status, observe, look, memory,
timeline, goals, skills) and *influence* (tell — words the agent weighs at its next thought —, suggest a
goal, speak in game on its behalf). Every call goes through the running mind's control channel so the agent
remembers what happened.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

from emeth import __version__
from emeth.control import ControlClient, ControlError

log = logging.getLogger(__name__)

SUPPORTED_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")

TOOLS: list[dict[str, Any]] = [
    {
        "name": "emeth_status",
        "description": "Who EMETH is right now: autonomy stage, health/food/position, goals and curriculum progress, drives, body connection, LLM router health.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "emeth_observe",
        "description": "What EMETH perceives this instant (honest perception: only what is in its field of view / nearby): self state, entities, blocks, inventory, recent chat. `detail: full` adds the complete visible-block list.",
        "inputSchema": {"type": "object", "properties": {"detail": {"type": "string", "enum": ["compact", "full"], "default": "compact"}}, "additionalProperties": False},
    },
    {
        "name": "emeth_look",
        "description": "See through EMETH's eyes: a retina frame (PNG, colour = block identity, brightness = depth) plus its text description and legend.",
        "inputSchema": {
            "type": "object",
            "properties": {"width": {"type": "integer", "minimum": 8, "maximum": 256, "default": 96}, "height": {"type": "integer", "minimum": 4, "maximum": 144, "default": 54}},
            "additionalProperties": False,
        },
    },
    {
        "name": "emeth_memory_search",
        "description": "Search EMETH's long-term memory (wiki pages: places, lessons, people, projects; and episodic memories) by meaning and keywords.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 30, "default": 8}}, "required": ["query"], "additionalProperties": False},
    },
    {
        "name": "emeth_timeline",
        "description": "EMETH's recent episodic timeline (what it did, saw, said, felt), most recent last.",
        "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 30}}, "additionalProperties": False},
    },
    {
        "name": "emeth_goals",
        "description": "Active goals, current task and survival-curriculum progress.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "emeth_skills",
        "description": "The skills EMETH has learned (name, description, success rate, version).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "emeth_tell",
        "description": "Speak to EMETH's mind from outside the game, as its mentor. It is advice it will weigh at its next thought — not a command. Use it to coach, warn, explain or ask it something; check emeth_timeline afterwards to see what it made of it.",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 1200}, "source": {"type": "string", "default": "mentor", "description": "who is speaking (shown to the agent)"}}, "required": ["text"], "additionalProperties": False},
    },
    {
        "name": "emeth_suggest_goal",
        "description": "Add a goal to EMETH's goal stack (it decides how, and may abandon it with a reason). Optional ordered sub-tasks and a priority 1 (urgent) … 9 (someday).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "maxLength": 200},
                "why": {"type": "string", "maxLength": 500},
                "priority": {"type": "integer", "minimum": 1, "maximum": 9, "default": 4},
                "tasks": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title"],
            "additionalProperties": False,
        },
    },
    {
        "name": "emeth_say",
        "description": "Make EMETH say something in the game chat (or whisper to a player with `to`). Goes through its body like any speech: no commands, 240 characters max.",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 240}, "to": {"type": "string"}}, "required": ["text"], "additionalProperties": False},
    },
]

TOOL_NAMES = {t["name"] for t in TOOLS}


def _text(obj: Any) -> dict[str, Any]:
    return {"type": "text", "text": obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=2, default=str)}


class McpStdioServer:
    """Reads JSON-RPC lines from `reader`, writes responses to `writer`. Tool calls go to the control channel."""

    def __init__(self, control: ControlClient, reader: asyncio.StreamReader, writer: Any):
        self.control = control
        self.reader = reader
        self.writer = writer
        self.initialized = False

    async def serve(self) -> None:
        while True:
            line = await self.reader.readline()
            if not line:
                return
            raw = line.decode("utf-8", errors="replace").strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await self._send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                continue
            if isinstance(msg, list):  # batch
                for m in msg:
                    await self._handle(m)
            else:
                await self._handle(msg)

    async def _send(self, obj: dict[str, Any]) -> None:
        data = (json.dumps(obj, ensure_ascii=False, default=str) + "\n").encode("utf-8")
        self.writer.write(data)
        drain = getattr(self.writer, "drain", None)
        if drain is not None:
            await drain()

    async def _handle(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            await self._send({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}})
            return
        method = msg.get("method")
        rid = msg.get("id")
        params = msg.get("params") or {}
        is_notification = "id" not in msg
        if not isinstance(method, str):
            if not is_notification:
                await self._send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32600, "message": "missing method"}})
            return
        try:
            result = await self.dispatch(method, params if isinstance(params, dict) else {})
        except _RpcError as exc:
            if not is_notification:
                await self._send({"jsonrpc": "2.0", "id": rid, "error": {"code": exc.code, "message": exc.message}})
            return
        if is_notification:
            return
        await self._send({"jsonrpc": "2.0", "id": rid, "result": result})

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "initialize":
            requested = str(params.get("protocolVersion") or SUPPORTED_PROTOCOLS[0])
            version = requested if requested in SUPPORTED_PROTOCOLS else SUPPORTED_PROTOCOLS[0]
            return {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "emeth", "version": __version__},
                "instructions": (
                    "EMETH is an autonomous Minecraft player with its own goals and memory. These tools let you look through its senses and "
                    "memory and talk to it as a mentor; they do not remote-control it. Start with emeth_status, then emeth_observe or emeth_look."
                ),
            }
        if method == "notifications/initialized":
            self.initialized = True
            return None
        if method.startswith("notifications/"):
            return None
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": TOOLS}
        if method == "tools/call":
            return await self.call_tool(str(params.get("name", "")), params.get("arguments") or {})
        if method in ("resources/list", "resources/templates/list"):
            return {"resources": []} if method == "resources/list" else {"resourceTemplates": []}
        if method == "prompts/list":
            return {"prompts": []}
        raise _RpcError(-32601, f"method not found: {method}")

    async def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name not in TOOL_NAMES:
            raise _RpcError(-32602, f"unknown tool {name!r}")
        try:
            content = await self._run_tool(name, args)
            return {"content": content, "isError": False}
        except ControlError as exc:
            return {"content": [_text(f"{exc.code}: {exc.message}")], "isError": True}
        except Exception as exc:  # noqa: BLE001
            log.exception("tool %s failed", name)
            return {"content": [_text(f"INTERNAL: {exc}")], "isError": True}

    async def _run_tool(self, name: str, a: dict[str, Any]) -> list[dict[str, Any]]:
        c = self.control
        if name == "emeth_status":
            return [_text(await c.call("status"))]
        if name == "emeth_observe":
            obs = await c.call("observe", {"detail": a.get("detail", "compact")})
            return [_text(summarize_observation(obs)), _text(obs)]
        if name == "emeth_look":
            r = await c.call("render", {"width": int(a.get("width", 96)), "height": int(a.get("height", 54))})
            return [
                {"type": "image", "data": r["pngBase64"], "mimeType": "image/png"},
                _text({"description": r.get("description"), "legend": r.get("legend"), "size": f"{r.get('width')}x{r.get('height')}"}),
            ]
        if name == "emeth_memory_search":
            return [_text(await c.call("memory_search", {"query": a["query"], "limit": int(a.get("limit", 8))}))]
        if name == "emeth_timeline":
            entries = await c.call("timeline", {"limit": int(a.get("limit", 30))})
            lines = [f"- {e['kind']}: {e['text']}" + (f" (x{e['count']})" if e.get("count", 1) > 1 else "") for e in entries]
            return [_text("\n".join(lines) or "(empty timeline)")]
        if name == "emeth_goals":
            return [_text(await c.call("goals"))]
        if name == "emeth_skills":
            return [_text(await c.call("skills"))]
        if name == "emeth_tell":
            return [_text(await c.call("tell", {"text": a["text"], "source": a.get("source", "mentor")}))]
        if name == "emeth_suggest_goal":
            params = {"title": a["title"], "why": a.get("why", ""), "priority": int(a.get("priority", 4)), "tasks": a.get("tasks") or None}
            return [_text(await c.call("set_goal", params))]
        if name == "emeth_say":
            return [_text(await c.call("say", {"text": a["text"], "to": a.get("to")}))]
        raise _RpcError(-32602, f"unknown tool {name!r}")


def summarize_observation(obs: dict[str, Any]) -> str:
    """A few human lines on top of the raw JSON, so a client without a JSON eye still gets the picture."""
    try:
        s, w, inv = obs["self"], obs["world"], obs["inventory"]
        pos = s["position"]
        ents = obs.get("entities", {})
        players = ", ".join(p.get("username") or "?" for p in ents.get("players", [])) or "nobody"
        hostiles = len(ents.get("hostiles", []))
        items = ", ".join(f"{i['count']} {i['name']}" for i in inv.get("items", [])[:12]) or "nothing"
        return (
            f"{s.get('username', 'EMETH')} at ({pos['x']:.0f}, {pos['y']:.0f}, {pos['z']:.0f}) in {s.get('dimension', '?')}, day {w.get('day')} {w.get('phase')}, "
            f"health {s.get('health')}/20, food {s.get('food')}/20. Players around: {players}. Hostiles in view: {hostiles}. "
            f"Standing on {obs.get('blocks', {}).get('standingOn', '?')}. Carrying: {items}."
        )
    except (KeyError, TypeError, ValueError):
        return "observation (see JSON)"


class _RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


async def serve_stdio(control: ControlClient) -> None:
    """Wire the server to the process' stdin/stdout (binary, line-buffered)."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)  # type: ignore[attr-defined]
    writer = asyncio.StreamWriter(transport, protocol, None, loop)
    server = McpStdioServer(control, reader, writer)
    await server.serve()
