import asyncio

from emeth.cognition.critic import Critic
from emeth.cognition.decide import DECISION_SCHEMA, manifest_text, parse_decision, system_prompt
from emeth.cognition.drives import Drives
from emeth.cognition.planner import LADDER, Planner, Task, check_success
from emeth.llm.mock import MockProvider
from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatResponse
from emeth.memory.consolidation import Consolidator
from emeth.memory.context import ContextBlocks, observation_blocks, render_action_result
from emeth.memory.episodic import Timeline
from emeth.memory.procedural import SkillLibrary
from emeth.memory.semantic import Wiki
from emeth.memory.social import SocialMemory
from emeth.memory.spatial import WorldGraph
from emeth.memory.store import MemoryStore
from emeth.protocol import ActionResult, HelloResult
from emeth.self.identity import AUTONOMY_LEVELS, Identity, IdentityMetrics, level_for
from tests.fakes import load_fixture, sample_observation


def test_drives_react_to_hunger_threats_and_night():
    d = Drives()
    obs = sample_observation()
    state = d.update(obs)
    assert state.hunger > 0.1  # food 13/20
    assert state.safety >= 0.3  # a zombie 9 blocks away
    text = state.render()
    assert "Mood" in text
    first_safety = state.safety
    night = sample_observation()
    night.world.phase = "night"
    night.world.skyLight = 15
    night.self_.health = 5
    s2 = d.update(night)
    assert s2.safety > first_safety and d.wake_priority() > 0.5
    d.on_event("death")
    d.update(night)
    assert d.state.mood < 0.6


def test_check_success_specs():
    obs = sample_observation()
    obs.inventory.items = [type(obs.inventory.items[0])(name="oak_log", count=6, slot=9), type(obs.inventory.items[0])(name="stone_pickaxe", count=1, slot=10), type(obs.inventory.items[0])(name="stone_sword", count=1, slot=11)]
    assert check_success({"inventory_any": [["any_log", 6]]}, obs)[0]
    assert not check_success({"inventory": {"stick": 8}}, obs)[0]
    assert check_success({"tool_tier": "stone"}, obs)[0]
    assert not check_success({"tool_tier": "iron"}, obs)[0]
    assert check_success({"inventory_any": [["placed:crafting_table", 1]]}, obs)[0]  # table visible nearby
    assert check_success({"custom": "shelter"}, obs, {"custom:shelter": True})[0]


def test_planner_ladder_and_goals(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    planner = Planner(store)
    task = planner.propose_curriculum_task()
    assert task is not None and task.source == "curriculum:wood"
    obs = sample_observation()
    obs.inventory.items = [type(obs.inventory.items[0])(name="oak_log", count=8, slot=9), type(obs.inventory.items[0])(name="oak_planks", count=12, slot=10)]
    newly = planner.refresh_milestones(obs)
    assert "wood" in newly and "planks" in newly and "table" in newly  # table placed nearby counts
    nxt = planner.next_milestone()
    assert nxt is not None and nxt[0] == "sticks"
    goal = planner.add_goal("test", [Task(description="do it", success={"inventory": {"stick": 8}})], source="llm")
    t = planner.current_task()
    assert t is not None and goal.status == "active"
    for _ in range(4):
        planner.fail_task(t, "nope")
    assert t.status == "failed" and goal.status == "failed"
    # persistence
    planner2 = Planner(store)
    assert "wood" in planner2.done_milestones and planner2.goals[0].status == "failed"
    assert len(LADDER) >= 20 and "Curriculum" in planner2.render()


def test_decision_parsing_validates_actions():
    hello = HelloResult.model_validate(load_fixture("hello.json"))
    known = {a.name for a in hello.actions}
    good = ChatResponse(json_data={"reason": "hungry", "speech": "", "action": {"type": "primitive", "name": "eat", "args": {}}, "remember": None})
    d = parse_decision(good, known)
    assert d.ok and d.action_name == "eat" and d.speech is None
    bad = ChatResponse(json_data={"reason": "x", "speech": "hi", "action": {"type": "primitive", "name": "teleport"}})
    d2 = parse_decision(bad, known)
    assert not d2.ok and "unknown primitive" in d2.problems[0]
    skill = ChatResponse(json_data={"reason": "x", "speech": None, "action": {"type": "skill", "goal": "build a 5x5 shelter"}, "goal_update": {"op": "add", "title": "shelter", "tasks": ["gather wood", "build"]}})
    d3 = parse_decision(skill, known)
    assert d3.ok and d3.skill_goal.startswith("build") and d3.goal_update["op"] == "add"
    wait = ChatResponse(json_data={"reason": "x", "speech": None, "action": {"type": "wait", "seconds": 9999, "for_what": "night"}})
    assert parse_decision(wait, known).wait_seconds == 300
    text = manifest_text(hello.actions)
    assert "- mine(" in text and "## mining" in text
    sp = system_prompt("PERSONA", text, "fr", "stage")
    assert "PERSONA" in sp and "Body interface" in sp
    assert DECISION_SCHEMA["required"] == ["reason", "speech", "action"]


def test_identity_levels_progress_with_experience():
    assert level_for(IdentityMetrics()).name == "newborn"
    m = IdentityMetrics(days_survived=3, skills_learned=6, distinct_items_crafted=5, conversations=5)
    assert level_for(m).name == "survivor"
    ident = Identity(name="Emeth", metrics=m)
    unlocked = ident.bump(structures_built=1, distinct_items_crafted=6, skills_learned=10, days_survived=2)
    assert unlocked is not None and unlocked.name == "builder" and ident.awakenings
    assert "builder" in ident.render()
    assert [lvl.level for lvl in AUTONOMY_LEVELS] == list(range(6))
    d = ident.to_dict()
    again = Identity.from_dict(d)
    assert again.level.name == "builder"


def test_context_blocks_render_within_budget():
    obs = sample_observation()
    blocks = ContextBlocks(**observation_blocks(obs, woke_by="chat from Steve"))
    blocks.identity = "I am Emeth"
    blocks.timeline = "x" * 10_000
    blocks.decision = "decide"
    text = blocks.render(budgets={"timeline": 500})
    assert text.startswith("[IDENTITY]") and "[DECISION]" in text
    assert "Woke by: chat from Steve" in text
    assert "THREATS: zombie" in text and "Steve" in text
    assert len(text) < 7000
    res = ActionResult(id="1", action="mine", ok=False, error="no logs", errorCode="NOT_FOUND", startedAt=0, finishedAt=1500)
    assert "FAILED (NOT_FOUND" in render_action_result(res)


async def test_critic_programmatic_then_llm(tmp_path):
    obs = sample_observation()
    critic = Critic(LLMRouter([MockProvider("m", responses=[{"success": True, "reasoning": "looks built", "critique": ""}])]))
    task = Task(description="mine 3 logs", success={"inventory": {"oak_log": 3}})
    verdict = await critic.verify(task, None, obs, "mined 0")
    assert not verdict.success and verdict.method == "programmatic"
    fuzzy = Task(description="decorate the house", kind="build")
    verdict2 = await critic.verify(fuzzy, obs, obs, "placed 12 blocks")
    assert verdict2.success and verdict2.method == "llm"


async def test_consolidation_dream_writes_pages_and_updates_identity(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    router = LLMRouter(
        [
            MockProvider(
                "m",
                responses=[
                    {
                        "day_summary": "I gathered wood and met Steve near the river.",
                        "lessons": [{"title": "Night is dangerous", "text": "Get indoors before dusk."}],
                        "places": [{"name": "river camp", "kind": "camp", "x": 12, "y": 64, "z": -40, "notes": "where I met Steve"}],
                        "people": [{"username": "Steve", "note": "friendly, gave me bread", "trust_delta": 1}],
                        "projects": [{"title": "First house", "status": "walls up", "next_step": "roof"}],
                        "identity_update": "I am no longer afraid of the dark.",
                        "ambitions": ["build a lighthouse"],
                        "mood": "hopeful",
                    }
                ],
            )
        ]
    )
    emb = __import__("emeth.llm.embeddings", fromlist=["Embedder"]).Embedder(router)
    wiki = Wiki(tmp_path / "wiki", store, emb)
    timeline = Timeline(store)
    timeline.add("chat_in", "Steve: hello")
    timeline.add("result", "mine succeeded")
    social = SocialMemory(store)
    graph = WorldGraph(tmp_path / "g.json")
    skills = SkillLibrary(tmp_path / "skills", store, emb)
    identity = Identity(name="Emeth")
    cons = Consolidator(router, store, wiki, timeline, social, graph, skills, identity)
    res = await cons.dream(day=1)
    assert res.session_page == "sessions/day-0001.md" and res.lessons == 1 and res.places == 1 and res.people == 1
    assert store.get_page("lessons/night-is-dangerous.md") is not None
    assert store.list_places()[0].name == "river camp"
    assert "afraid of the dark" in identity.narrative and identity.ambitions == ["build a lighthouse"]
    assert identity.metrics.nights_slept == 1 and identity.metrics.lessons == 1
    assert store.unconsolidated_episodes() == []
    assert store.get_page("identity/self.md").pinned  # type: ignore[union-attr]
    # rolling rewrite uses the fast tier and stores both blocks
    router.providers["m"].responses.append({"previously": "Shared past: met Steve.", "about_players": "Steve: kind."})  # type: ignore[attr-defined]
    prev, about = await cons.rewrite_rolling()
    assert prev.startswith("Shared past") and "Steve" in about


def test_asyncio_marker_sanity():
    assert asyncio.get_event_loop_policy() is not None


class _FinishingProvider(MockProvider):
    """A mock that also reports a finish reason, and counts the calls."""

    finish_reason = "stop"

    async def chat(self, request):  # type: ignore[no-untyped-def]
        resp = await super().chat(request)
        await asyncio.sleep(0.01)
        return resp.model_copy(update={"finish_reason": self.finish_reason})


async def test_rolling_rewrite_runs_once_and_backs_off_after_a_failure(tmp_path):
    store = MemoryStore(tmp_path / "m.sqlite")
    provider = _FinishingProvider("m", responses=[])
    router = LLMRouter([provider])
    emb = __import__("emeth.llm.embeddings", fromlist=["Embedder"]).Embedder(router)
    timeline = Timeline(store)
    for i in range(30):
        timeline.add("note", f"event {i}")
    cons = Consolidator(router, store, Wiki(tmp_path / "wiki", store, emb), timeline, SocialMemory(store), WorldGraph(tmp_path / "g.json"), SkillLibrary(tmp_path / "skills", store, emb), Identity(name="Emeth"))
    store.set("rolling.previously", "old past")
    # a truncated answer keeps the old blocks, and the counter restarts so the next try waits for new events
    provider.responses.append({"previously": "half a", "about_players": ""})
    provider.finish_reason = "length"
    prev, _ = await cons.rewrite_rolling()
    assert prev == "old past" and timeline.since_rewrite() == 0
    # concurrent calls: only one reaches the model
    provider.finish_reason = "stop"
    provider.responses.extend([{"previously": "new past", "about_players": "nobody"}] * 2)
    calls = len(provider.requests)
    await asyncio.gather(cons.rewrite_rolling(), cons.rewrite_rolling())
    assert len(provider.requests) - calls == 1 and store.get("rolling.previously") == "new past"
