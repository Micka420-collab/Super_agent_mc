"""Control channel + MCP façade: a real websockets server over a mind built on fakes, then the MCP stdio
server driven exactly like Claude Code would (initialize → tools/list → tools/call)."""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any

import pytest

from emeth.config import Settings
from emeth.control import ControlAPI, ControlClient, ControlError
from emeth.llm.mock import MockProvider
from emeth.llm.router import LLMRouter
from emeth.mcp.server import SUPPORTED_PROTOCOLS, TOOLS, McpStdioServer, summarize_observation
from emeth.runtime import Mind, build_mind
from tests.fakes import FakeWorld, fake_transport_factory
from tests.test_loop import scripted_brain


async def make_mind(tmp_path: Path, world: FakeWorld) -> Mind:
    settings = Settings(data_dir=tmp_path / "data", skills_dir=tmp_path / "skills", control_port=0, control_token="t0k3n", providers_path=None)
    router = LLMRouter([MockProvider("brain", script=scripted_brain)], max_requests_per_minute=1000)
    mind = build_mind(settings, router=router, transport=fake_transport_factory(world))
    await mind.start()
    return mind


class Pipe:
    """An in-memory stdin/stdout pair for the MCP server."""

    def __init__(self) -> None:
        self.to_server = asyncio.StreamReader()
        self.from_server: list[dict[str, Any]] = []
        self._buf = b""

    # writer interface used by McpStdioServer
    def write(self, data: bytes) -> None:
        self._buf += data
        while b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            if line.strip():
                self.from_server.append(json.loads(line))

    async def drain(self) -> None:
        return None

    def send(self, msg: dict[str, Any]) -> None:
        self.to_server.feed_data((json.dumps(msg) + "\n").encode())

    async def response(self, rid: Any, wait_s: float = 5.0) -> dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + wait_s
        while asyncio.get_running_loop().time() < deadline:
            for m in self.from_server:
                if m.get("id") == rid:
                    return m
            await asyncio.sleep(0.01)
        raise AssertionError(f"no response for {rid}: {self.from_server}")


@pytest.fixture
async def mind_and_world(tmp_path):
    world = FakeWorld()
    mind = await make_mind(tmp_path, world)
    try:
        yield mind, world
    finally:
        await mind.close()


async def test_control_server_authenticates_and_dispatches(mind_and_world):
    mind, world = mind_and_world
    assert mind.control is not None and mind.control.port > 0
    assert (mind.settings.data_dir / "control.token").read_text() == "t0k3n"
    good = ControlClient(mind.control.url, "t0k3n")
    status = await good.call("status")
    assert status["name"] == "Emeth" and status["body"]["connected"] is True and status["autonomy"]["level"] == 0
    bad = ControlClient(mind.control.url, "wrong")
    with pytest.raises(ControlError) as exc:
        await bad.call("status")
    assert exc.value.code in ("UNAUTHORIZED", "UNREACHABLE")
    with pytest.raises(ControlError) as exc2:
        await good.call("teleport", {"x": 1})
    assert exc2.value.code == "UNKNOWN_METHOD"
    with pytest.raises(ControlError) as exc3:
        await good.call("say", {"text": ""})
    assert exc3.value.code == "BAD_REQUEST"


async def test_influence_goes_through_the_agents_own_memory(mind_and_world):
    mind, world = mind_and_world
    api = ControlAPI(mind)
    # a goal suggested from outside appears in the planner, wakes the loop, and is logged
    res = await api.dispatch("set_goal", {"title": "Build a watchtower by the river", "why": "the owner asked", "priority": 3, "tasks": ["gather 64 cobblestone", "build the tower"]})
    assert res["goal"]["source"] == "mentor" and len(res["goal"]["tasks"]) == 2
    assert "Build a watchtower by the river" in mind.planner.render()
    assert mind.loop is not None and mind.loop._wake.is_set()  # noqa: SLF001
    # a mentor message is remembered and surfaces in the next thought's context, once
    await api.dispatch("tell", {"text": "Careful, creepers spawn behind the hill at night.", "source": "Micka"})
    kinds = [e.kind for e in mind.timeline.entries]
    assert "mentor_in" in kinds and "plan" in kinds
    obs = await mind.body.observe("compact")
    ctx = await mind.loop._context(obs, "mentor:Micka")  # noqa: SLF001
    assert "[MENTOR]" in ctx and "Micka says: Careful, creepers" in ctx
    ctx2 = await mind.loop._context(obs, "quiet")  # noqa: SLF001
    assert "[MENTOR]" not in ctx2
    # speech goes through the body as chat (never a command) and is logged as said
    await api.dispatch("say", {"text": "/op me please"})
    assert world.chats[-1][0] == "/op me please"  # the body strips slashes itself; the mind does not forge commands
    assert any(e.kind == "said" for e in mind.timeline.entries)
    # memory search and timeline are the same memory the agent uses
    mem = await api.dispatch("memory_search", {"query": "creepers hill", "limit": 5})
    assert "pages" in mem and "episodes" in mem
    tl = await api.dispatch("timeline", {"limit": 10})
    assert any("creepers" in e["text"] for e in tl)
    assert (await api.dispatch("abandon_goal", {"title": "Build a watchtower by the river"}))["abandoned"] is True


async def test_mcp_stdio_server_speaks_the_protocol(mind_and_world):
    mind, world = mind_and_world
    pipe = Pipe()
    server = McpStdioServer(ControlClient(mind.control.url, "t0k3n"), pipe.to_server, pipe)  # type: ignore[arg-type]
    task = asyncio.create_task(server.serve())
    try:
        pipe.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "x"}}})
        init = await pipe.response(1)
        assert init["result"]["protocolVersion"] == "2025-03-26"
        assert init["result"]["capabilities"]["tools"] == {"listChanged": False}
        assert init["result"]["serverInfo"]["name"] == "emeth"
        pipe.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        pipe.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools = (await pipe.response(2))["result"]["tools"]
        assert [t["name"] for t in tools] == [t["name"] for t in TOOLS]
        assert all("inputSchema" in t and t["inputSchema"]["type"] == "object" for t in tools)
        # look through its eyes: image content + description
        pipe.send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "emeth_look", "arguments": {"width": 16, "height": 8}}})
        look = (await pipe.response(3))["result"]
        assert look["isError"] is False
        assert look["content"][0]["type"] == "image" and look["content"][0]["mimeType"] == "image/png"
        base64.b64decode(look["content"][0]["data"])
        assert "stone everywhere" in look["content"][1]["text"]
        # mentor message + goal through MCP end up in the agent's memory
        pipe.send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "emeth_tell", "arguments": {"text": "Try to find iron before dark."}}})
        assert (await pipe.response(4))["result"]["isError"] is False
        pipe.send({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "emeth_suggest_goal", "arguments": {"title": "Find iron", "priority": 2}}})
        goal = (await pipe.response(5))["result"]
        assert goal["isError"] is False and "Find iron" in goal["content"][0]["text"]
        assert any(e.kind == "mentor_in" and "iron" in e.text for e in mind.timeline.entries)
        pipe.send({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "emeth_observe", "arguments": {}}})
        obs = (await pipe.response(6))["result"]
        assert obs["content"][0]["type"] == "text" and "health" in obs["content"][0]["text"]
        # errors are tool results, not protocol failures; unknown methods are JSON-RPC errors; ping works
        pipe.send({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "emeth_say", "arguments": {"text": "   "}}})
        bad = (await pipe.response(7))["result"]
        assert bad["isError"] is True and "BAD_REQUEST" in bad["content"][0]["text"]
        pipe.send({"jsonrpc": "2.0", "id": 8, "method": "resources/read", "params": {"uri": "x"}})
        assert (await pipe.response(8))["error"]["code"] == -32601
        pipe.send({"jsonrpc": "2.0", "id": 9, "method": "ping"})
        assert (await pipe.response(9))["result"] == {}
        pipe.send({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "emeth_teleport", "arguments": {}}})
        assert (await pipe.response(10))["error"]["code"] == -32602
    finally:
        pipe.to_server.feed_eof()
        await asyncio.wait_for(task, 5)


async def test_mcp_reports_an_unreachable_mind_as_a_tool_error():
    pipe = Pipe()
    server = McpStdioServer(ControlClient("ws://127.0.0.1:1", "x", timeout_s=2), pipe.to_server, pipe)  # type: ignore[arg-type]
    task = asyncio.create_task(server.serve())
    pipe.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
    assert (await pipe.response(1))["result"]["protocolVersion"] == SUPPORTED_PROTOCOLS[0]
    pipe.send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "emeth_status", "arguments": {}}})
    res = (await pipe.response(2, wait_s=10))["result"]
    assert res["isError"] is True and "UNREACHABLE" in res["content"][0]["text"]
    pipe.to_server.feed_eof()
    await asyncio.wait_for(task, 5)


def test_observation_summary_is_readable():
    obs = {
        "self": {"username": "Emeth", "position": {"x": 10.4, "y": 64, "z": -3.2}, "dimension": "overworld", "health": 18, "food": 12},
        "world": {"day": 3, "phase": "dusk"},
        "inventory": {"items": [{"name": "oak_log", "count": 6}]},
        "entities": {"players": [{"username": "Steve"}], "hostiles": [{}, {}]},
        "blocks": {"standingOn": "grass_block"},
    }
    text = summarize_observation(obs)
    assert "Emeth at (10, 64, -3)" in text and "day 3 dusk" in text and "Steve" in text and "Hostiles in view: 2" in text and "6 oak_log" in text
    assert summarize_observation({}) == "observation (see JSON)"
