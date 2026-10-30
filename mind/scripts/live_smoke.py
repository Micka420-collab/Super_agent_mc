"""Live smoke test: real body + mind with a scripted brain (no LLM key needed).

Start a Minecraft server (server/docker-compose.yml or flying-squid) and the body, then:
    EMETH_BRIDGE_URL=ws://127.0.0.1:8765 EMETH_BRIDGE_TOKEN=change-me python scripts/live_smoke.py
It greets, walks 5 blocks, synthesises and runs a skill in the sandbox, and exports a soul bundle to a temp dir.
"""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from pathlib import Path

from emeth.config import LoopConfig, Settings
from emeth.llm.mock import MockProvider
from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatRequest
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
    settings = Settings(data_dir=tmp / "data", skills_dir=tmp / "skills", loop=LoopConfig(memory_rewrite_every_events=999))
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
