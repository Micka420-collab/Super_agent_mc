"""Live smoke test: real body + mind with a scripted brain (no LLM key needed).

Start a Minecraft server (server/docker-compose.yml or flying-squid) and the body, then:
    EMETH_BRIDGE_URL=ws://127.0.0.1:8765 EMETH_BRIDGE_TOKEN=change-me python scripts/live_smoke.py
It greets, walks 5 blocks, synthesises and runs a skill in the sandbox, talks to itself through the control channel
and the MCP façade (status, look, tell, suggest a goal), and exports a soul bundle to a temp dir.
"""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from pathlib import Path

from emeth.config import LoopConfig, Settings
from emeth.control import ControlClient
from emeth.llm.mock import MockProvider
from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatRequest
from emeth.mcp.server import McpStdioServer
from emeth.memory.soul import export_soul
from emeth.runtime import build_mind
from emeth.social.persona import Persona

logging.basicConfig(level=logging.WARNING)

START = {"x": 0.0, "y": 64.0, "z": 0.0}


def brain(req: ChatRequest):
    purpose = req.purpose
    user = req.messages[-1].content
    if purpose == "decision":
        if "Woke by: startup" in user:
            return {
                "reason": "look around and say hi",
                "speech": "Bonjour le monde, je suis réveillé.",
                "action": {"type": "primitive", "name": "find_blocks", "args": {"names": ["grass_block"], "maxDistance": 6, "count": 3}},
            }
        if "Woke by: dig" in user:
            return {"reason": "test a skill", "speech": None, "action": {"type": "skill", "goal": "dig two grass blocks nearby"}}
        if "[MENTOR]" in user:
            return {"reason": "my mentor spoke", "speech": "Merci Micka, je vais chercher du fer.", "action": {"type": "none"}}
        if "Woke by: walk" in user:
            return {"reason": "stretch legs", "speech": None, "action": {"type": "primitive", "name": "goto", "args": {"x": START["x"] + 5, "y": START["y"], "z": START["z"], "range": 1.5}}}
        return {"reason": "nothing", "speech": None, "action": {"type": "none"}}
    if purpose.startswith("skill.synthesis"):
        return {
            "plan": "dig",
            "name": "dig_grass_nearby",
            "description": "Dig two grass blocks near me",
            "code": "async function main(api, args) { const r = await api.mine({ name: 'grass_block', count: 2, maxDistance: 8 }); api.log('dug', JSON.stringify(r)); return r; }",
            "args": {},
        }
    if purpose == "critic":
        return {"success": True, "reasoning": "blocks dug", "critique": ""}
    return {"previously": "x", "about_players": "y"}


async def main() -> None:
    tmp = Path(tempfile.mkdtemp())
    settings = Settings(data_dir=tmp / "data", skills_dir=tmp / "skills", loop=LoopConfig(memory_rewrite_every_events=999), control_port=0)
    router = LLMRouter([MockProvider("brain", script=brain)], max_requests_per_minute=1000)
    mind = build_mind(settings, router=router, persona=Persona(name="Emeth", owner="Micka"))
    loop = await mind.start()
    hello = mind.body.hello
    assert hello is not None
    print("HELLO", hello.minecraft, len(hello.actions), "actions, vision", hello.capabilities["vision"])
    obs = await mind.body.observe("full")
    START.update({"x": obs.self_.position.x, "y": obs.self_.position.y, "z": obs.self_.position.z})
    assert obs.vision is not None
    print("OBS pos", obs.self_.position.short(), "standing on", obs.blocks.standingOn, "visible", len(obs.vision.visible))
    frame = await mind.body.render(width=48, height=27)
    print("RETINA", frame.width, frame.height, len(frame.pngBase64), frame.description[:100])

    async def finish() -> None:
        if loop._action_task:  # noqa: SLF001
            await asyncio.wait_for(loop._action_task, 60)  # noqa: SLF001
            await asyncio.sleep(0.2)

    for reason in ("startup", "walk", "dig"):
        await loop.think(reason)
        await finish()
    after = await mind.body.observe()
    print("WALKED to", after.self_.position.short())

    # --- control channel + MCP façade against the live mind -------------------------------------
    assert mind.control is not None
    ctl = ControlClient(mind.control.url, mind.control.token)
    status = await ctl.call("status")
    print("CONTROL status", status["name"], status["autonomy"], "body", status["body"]["connected"], "pos", status.get("self", {}).get("position"))
    frame2 = await ctl.call("render", {"width": 32, "height": 18})
    print("CONTROL render", frame2["width"], frame2["height"], frame2["description"][:60])

    class Pipe:
        def __init__(self) -> None:
            self.reader = asyncio.StreamReader()
            self.out: list[dict] = []
            self.buf = b""

        def write(self, data: bytes) -> None:
            self.buf += data
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                if line.strip():
                    self.out.append(json.loads(line))

        async def drain(self) -> None:
            return None

        def send(self, msg: dict) -> None:
            self.reader.feed_data((json.dumps(msg) + "\n").encode())

        async def wait(self, rid: int) -> dict:
            for _ in range(500):
                for m in self.out:
                    if m.get("id") == rid:
                        return m
                await asyncio.sleep(0.02)
            raise RuntimeError(f"no response {rid}")

    pipe = Pipe()
    mcp = McpStdioServer(ctl, pipe.reader, pipe)
    task = asyncio.create_task(mcp.serve())
    pipe.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "live_smoke", "version": "0"}}})
    print("MCP initialize", (await pipe.wait(1))["result"]["serverInfo"])
    pipe.send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "emeth_look", "arguments": {"width": 24, "height": 12}}})
    look = (await pipe.wait(2))["result"]
    print("MCP look", look["content"][0]["type"], len(look["content"][0]["data"]), "chars of PNG;", look["content"][1]["text"][:70].replace("\n", " "))
    pipe.send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "emeth_tell", "arguments": {"text": "Cherche du fer avant la nuit.", "source": "Micka"}}})
    print("MCP tell", (await pipe.wait(3))["result"]["content"][0]["text"].replace("\n", " "))
    pipe.send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "emeth_suggest_goal", "arguments": {"title": "Trouver du fer", "priority": 2}}})
    print("MCP goal", (await pipe.wait(4))["result"]["isError"] is False)
    # the next thought sees the mentor's words and answers in game
    await loop.think("mentor:Micka")
    await finish()
    pipe.send({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "emeth_timeline", "arguments": {"limit": 6}}})
    print("MCP timeline\n" + (await pipe.wait(5))["result"]["content"][0]["text"])
    pipe.reader.feed_eof()
    await asyncio.wait_for(task, 5)
    print("SKILLS", [s.name for s in mind.skills.records()], "learned", mind.identity.metrics.skills_learned)
    print("TIMELINE")
    for e in loop.timeline.entries:
        print("  ", e.kind, "|", e.text[:110])
    print("SNAPSHOT", json.dumps(loop.snapshot()["stats"]))
    out = export_soul(tmp / "data" / "soul", mind.store, mind.identity, mind.wiki, mind.graph, mind.skills)
    print("SOUL", sorted(p.name for p in out.iterdir()))
    await mind.close()


if __name__ == "__main__":
    asyncio.run(main())
