import asyncio

from emeth.bridge.client import BodyClient, BodyEvent
from emeth.cognition.critic import Critic
from emeth.cognition.drives import Drives
from emeth.cognition.loop import CognitiveLoop
from emeth.cognition.planner import Planner
from emeth.cognition.skills import SkillSynthesizer
from emeth.config import LoopConfig
from emeth.llm.embeddings import Embedder
from emeth.llm.mock import MockProvider
from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatRequest
from emeth.memory.consolidation import Consolidator
from emeth.memory.episodic import Timeline
from emeth.memory.procedural import SkillLibrary
from emeth.memory.semantic import Wiki
from emeth.memory.social import SocialMemory
from emeth.memory.spatial import WorldGraph
from emeth.memory.store import MemoryStore
from emeth.self.identity import Identity
from emeth.social.persona import Persona
from tests.fakes import FakeWorld, fake_transport_factory


def scripted_brain(request: ChatRequest):
    """Route by purpose so one mock serves decisions, critic, skills and memory."""
    purpose = request.purpose
    user = request.messages[-1].content
    if purpose == "decision":
        if "[CORRECTION]" in user:
            return {"reason": "ok, valid now", "speech": None, "action": {"type": "primitive", "name": "look_at_player", "args": {"username": "Steve"}}}
        if "Woke by: startup" in user:
            return {"reason": "greet", "speech": "Salut Steve !", "action": {"type": "primitive", "name": "look_at_player", "args": {"username": "Steve"}}, "remember": "Steve's camp is at 12, 64, -40"}
        if "Woke by: chat from Steve" in user:
            return {"reason": "he asked", "speech": "j'arrive", "whisper_to": None, "action": {"type": "primitive", "name": "goto_entity", "args": {"username": "Steve", "range": 2}}}
        if "Woke by: invalid" in user:
            return {"reason": "bad", "speech": None, "action": {"type": "primitive", "name": "teleport", "args": {}}}
        if "Woke by: skill" in user:
            return {"reason": "need wood", "speech": None, "action": {"type": "skill", "goal": "collect 6 oak logs from nearby trees"}}
        return {"reason": "nothing", "speech": None, "action": {"type": "none"}}
    if purpose.startswith("skill.synthesis"):
        return {"plan": "1. find 2. mine", "name": "collect_oak_logs", "description": "Collect oak logs", "code": "async function main(api, args) { return await api.mine({ name: 'oak_log', count: 6 }); }", "args": {}}
    if purpose == "critic":
        return {"success": True, "reasoning": "logs in inventory", "critique": ""}
    if purpose == "memory.dream":
        return {"day_summary": "A fine day.", "lessons": [], "places": [], "people": [], "projects": [], "identity_update": "", "ambitions": [], "mood": "calm"}
    if purpose == "memory.rolling":
        return {"previously": "Shared past: met Steve.", "about_players": "Steve: friendly."}
    return {"ok": True}


async def make_loop(tmp_path, world: FakeWorld, synth: bool = True) -> tuple[CognitiveLoop, BodyClient, MockProvider]:
    provider = MockProvider("brain", script=scripted_brain)
    router = LLMRouter([provider], max_requests_per_minute=1000)
    store = MemoryStore(tmp_path / "m.sqlite")
    emb = Embedder(router)
    wiki = Wiki(tmp_path / "wiki", store, emb)
    timeline = Timeline(store)
    persona = Persona(name="Emeth", owner="Steve")
    social = SocialMemory(store, owner="Steve")
    graph = WorldGraph(tmp_path / "g.json")
    skills = SkillLibrary(tmp_path / "skills", store, emb)
    identity = Identity(name="Emeth")
    planner = Planner(store)
    cons = Consolidator(router, store, wiki, timeline, social, graph, skills, identity)
    body = BodyClient(fake_transport_factory(world))
    await body.connect()
    synthesizer = SkillSynthesizer(router, body, skills, max_attempts=2) if synth else None
    loop = CognitiveLoop(body=body, router=router, store=store, wiki=wiki, timeline=timeline, social=social, graph=graph, identity=identity, persona=persona, planner=planner, drives=Drives(), consolidator=cons, synthesizer=synthesizer, critic=Critic(router), config=LoopConfig(memory_rewrite_every_events=3))
    return loop, body, provider


async def wait_for_action_task(loop: CognitiveLoop) -> None:
    if loop._action_task:  # noqa: SLF001
        await asyncio.wait_for(loop._action_task, 5)  # noqa: SLF001
        await asyncio.sleep(0.05)


async def test_startup_decision_speaks_acts_and_sets_a_goal(tmp_path):
    world = FakeWorld()
    loop, body, provider = await make_loop(tmp_path, world)
    await loop.think("startup")
    await wait_for_action_task(loop)
    assert world.chats == [("Salut Steve !", None)]
    assert world.actions[0][0] == "look_at_player"
    # the curriculum gave the newborn its first goal
    assert loop.planner.current_task() is not None and loop.planner.current_task().source == "curriculum:wood"  # type: ignore[union-attr]
    # remember → a place page (coordinates detected)
    await asyncio.sleep(0.05)
    assert any(p.kind == "place" for p in loop.store.list_pages())
    kinds = [e.kind for e in loop.timeline.entries]
    assert "said" in kinds and "action" in kinds and "result" in kinds
    assert loop.stats.decisions == 1 and loop.identity.metrics.conversations == 1
    await body.close()


async def test_chat_event_wakes_and_invalid_decision_is_retried(tmp_path):
    world = FakeWorld()
    loop, body, provider = await make_loop(tmp_path, world)
    reason, delay = loop._handle_event(BodyEvent(event="chat", ts=0, payload={"from": "Steve", "text": "Emeth viens voir"}))  # noqa: SLF001
    assert reason == "chat from Steve" and delay == 300
    assert loop.store.get_person("Steve") is not None
    await loop.think("chat from Steve")
    await wait_for_action_task(loop)
    assert ("j'arrive", None) in world.chats
    assert world.actions[-1] == ("goto_entity", {"username": "Steve", "range": 2})
    # invalid primitive → correction round trip
    await loop.think("invalid")
    await wait_for_action_task(loop)
    assert world.actions[-1][0] == "look_at_player"
    decisions = [r for r in provider.requests if r.purpose == "decision"]
    assert any("[CORRECTION]" in r.messages[-1].content for r in decisions)
    assert any("my first thought was invalid" in e.text for e in loop.timeline.entries)
    await body.close()


async def test_skill_path_learns_and_completes_task(tmp_path):
    world = FakeWorld()
    world.add_inventory("oak_log", 6)
    loop, body, provider = await make_loop(tmp_path, world)
    await loop.think("skill")
    await wait_for_action_task(loop)
    assert world.skill_runs and world.skill_runs[0]["name"] == "collect_oak_logs"
    assert loop.synthesizer is not None and loop.synthesizer.library.get("collect_oak_logs") is not None
    assert loop.identity.metrics.skills_learned == 1
    # the first ladder milestone (6 logs) is verified programmatically by the critic
    assert "wood" in loop.planner.done_milestones
    assert any(e.kind == "achievement" for e in loop.timeline.entries)
    await body.close()


async def test_sleep_event_triggers_dream_and_rolling_rewrite(tmp_path):
    world = FakeWorld()
    loop, body, provider = await make_loop(tmp_path, world, synth=False)
    for i in range(4):
        loop.timeline.add("chat_in", f"Steve: msg {i}")
    await loop.think("startup")  # rewrite scheduled because > memory_rewrite_every_events
    await asyncio.sleep(0.1)
    assert loop.store.get("rolling.previously", "").startswith("Shared past")
    loop._handle_event(BodyEvent(event="sleep", ts=0, payload={"day": 3}))  # noqa: SLF001
    await asyncio.sleep(0.3)
    assert loop.stats.dreams == 1
    assert loop.store.get_page("sessions/day-0003.md") is not None
    assert loop.identity.metrics.nights_slept == 1
    snap = loop.snapshot()
    assert snap["identity"]["level"] == "newborn" and snap["stats"]["dreams"] == 1
    await body.close()


async def test_run_loop_processes_events_end_to_end(tmp_path):
    world = FakeWorld()
    loop, body, provider = await make_loop(tmp_path, world, synth=False)
    task = asyncio.create_task(loop.run())
    await asyncio.sleep(0.3)
    transport = body._transport  # type: ignore[attr-defined]
    await transport.emit("whisper", {"from": "Steve", "text": "tu es là ?"})  # type: ignore[attr-defined]
    await asyncio.sleep(0.6)
    loop.stop()
    await asyncio.wait_for(task, 5)
    assert loop.stats.decisions >= 2  # startup + whisper
    assert any(e.kind == "whisper_in" for e in loop.timeline.entries)
    assert world.reflex_config.get("allies") == ["Steve"]
    await body.close()


async def test_watching_a_player_build_is_remembered_on_the_map_and_the_person(tmp_path):
    world = FakeWorld()
    loop, body, provider = await make_loop(tmp_path, world)
    small = {"username": "Steve", "kind": "dug", "count": 4, "blocks": {"stone": 4}, "min": {"x": 1, "y": 60, "z": 1}, "max": {"x": 2, "y": 60, "z": 2}, "text": "Steve dug 4 stone around (1, 60, 1) — a 2×1×2 area, 6s"}
    assert loop._handle_event(BodyEvent(event="player.activity", ts=0, payload=small)) == (None, 0)  # noqa: SLF001
    assert any(e.kind == "observed" and "Steve dug 4 stone" in e.text for e in loop.timeline.entries)
    big = {"username": "Steve", "kind": "built", "count": 30, "blocks": {"oak_planks": 24, "glass_pane": 6}, "min": {"x": 10, "y": 64, "z": 10}, "max": {"x": 15, "y": 67, "z": 14}, "text": "Steve placed 24 oak_planks, 6 glass_pane around (12, 65, 12) — a 6×4×5 area, 40s"}
    reason, delay = loop._handle_event(BodyEvent(event="player.activity", ts=0, payload=big))  # noqa: SLF001
    assert reason == "Steve is building nearby" and delay == 5000
    structures = [n for n in loop.graph.nodes_of("structure") if n.label == "Steve's build"]
    assert len(structures) == 1 and abs(structures[0].x - 12.5) < 0.01
    person = loop.store.get_person("Steve")
    assert person is not None and any("builds things" in n for n in person.notes)
    await body.close()
