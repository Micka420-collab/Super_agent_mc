"""Design → survey → dry run → procure → build, against the simulated body."""

from __future__ import annotations

from typing import Any

from emeth.bridge.client import BodyClient
from emeth.builder.compiler import house_spec
from emeth.builder.designer import Designer
from emeth.cognition.construction import Constructor, choose_origin, facing_vector
from emeth.cognition.decide import parse_decision
from emeth.llm.mock import MockProvider
from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatRequest, ChatResponse, Usage
from tests.fakes import FakeWorld, fake_transport_factory, sample_observation
from tests.test_loop import make_loop, scripted_brain, wait_for_action_task


def body_sim(world: FakeWorld) -> None:
    """Teach the fake body the three building primitives the constructor relies on."""
    world.hello["actions"] = world.hello["actions"] + [{"name": n, "category": "building", "description": n, "params": {"type": "object"}, "longRunning": n == "build"} for n in ("surface_height", "plan_build", "build") if n not in {a["name"] for a in world.hello["actions"]}]

    def handler(name: str, args: dict[str, Any], w: FakeWorld) -> Any:
        if name == "surface_height":
            return {"center": {"x": args["x"], "z": args["z"]}, "radius": args["radius"], "heights": [[63] * 5 for _ in range(5)], "min": 63, "max": 63, "roughness": 0, "surfaceBlocks": {"grass_block": 25}}
        if name == "plan_build":
            blocks = args["blocks"]
            floating = [b for b in blocks if b["y"] > 70]
            order = [b for b in blocks if b["y"] <= 70]
            return {"feasible": not floating, "order": order, "unsupported": floating, "enclosed": [], "occupied": [], "unloaded": [], "alreadyCorrect": [], "materials": {}, "missing": {}, "estimatedSeconds": len(order), "text": f"{len(order)} blocks to place"}
        if name == "build":
            blocks = args["blocks"]
            w.built = blocks  # type: ignore[attr-defined]
            return {"planned": len(blocks), "alreadyCorrect": 0, "placed": len(blocks), "skipped": 0, "failures": [], "failureCount": 0, "missing": {}, "procured": {"oak_planks": "got 20"}, "inventoryDelta": {}}
        return {"done": True}

    world.action_handler = handler


def test_origin_is_ahead_of_the_agent_on_the_ground():
    obs = sample_observation()
    obs.self_.yaw = 0.0  # mineflayer yaw 0 → facing -z (north)
    dx, dz = facing_vector(0.0)
    assert abs(dx) < 1e-9 and dz == -1.0
    origin = choose_origin(obs, (5, 4, 5), ground_y=63)
    px, pz = obs.self_.position.x, obs.self_.position.z
    assert origin[1] == 64
    assert origin[0] <= px <= origin[0] + 5  # centred on the agent's x
    assert origin[2] + 5 < pz  # entirely in front (north)


async def test_constructor_pipeline_with_a_scripted_architect(tmp_path):
    world = FakeWorld()
    body_sim(world)
    spec = house_spec(w=5, d=5, h=3).model_dump()
    responses = [{"spec": spec, "rationale": "cottage"}, {"score": 8.0, "problems": [], "improvements": [], "accept": True}]
    router = LLMRouter([MockProvider("m", responses=responses)])
    body = BodyClient(fake_transport_factory(world))
    await body.connect()
    obs = await body.observe()
    notes: list[str] = []
    outcome = await Constructor(Designer(router, max_attempts=2), body).build_from_brief("a small cottage with a door", obs, progress=notes.append)
    assert outcome.ok, outcome.summary()
    assert outcome.origin is not None and outcome.origin[1] == 64
    assert outcome.dry_run is not None and outcome.dry_run["text"].endswith("blocks to place")
    assert [a[0] for a in world.actions] == ["surface_height", "plan_build", "build"]
    build_args = world.actions[-1][1]
    assert build_args["procure"] is True and build_args["partial"] is True and len(build_args["blocks"]) > 20
    assert any(n.startswith("surveyed the site") for n in notes) and any(n.startswith("designed") for n in notes)
    assert "placed" in outcome.summary() and "oak" in str(outcome.design.blueprint.bill_of_materials())  # type: ignore[union-attr]
    # the design prompt carried the site survey
    prompt = router.providers["m"].requests[0].messages[-1].content  # type: ignore[attr-defined]
    assert "Ground level y=63" in prompt and "grass_block" in prompt
    await body.close()


async def test_constructor_reports_design_failures_honestly(tmp_path):
    world = FakeWorld()
    body_sim(world)
    router = LLMRouter([MockProvider("m", responses=[{"spec": {"name": "bad", "primitives": []}, "rationale": "x"}])])
    body = BodyClient(fake_transport_factory(world))
    await body.connect()
    obs = await body.observe()
    outcome = await Constructor(Designer(router, max_attempts=1), body).build_from_brief("a tower", obs)
    assert not outcome.ok and "could not design it" in outcome.summary()
    assert [a[0] for a in world.actions] == ["surface_height"]  # nothing placed, nothing procured
    await body.close()


def test_decision_schema_accepts_design_actions():
    known = {"goto"}
    good = parse_decision(ChatResponse(text="", json_data={"reason": "home", "speech": None, "action": {"type": "design", "brief": "a cosy spruce cabin facing the lake", "size": [7, 5, 7]}}, provider="m", model="m", usage=Usage()), known)
    assert good.ok and good.action_type == "design" and good.design_brief.startswith("a cosy") and good.design_size == (7, 5, 7)  # type: ignore[union-attr]
    bad = parse_decision(ChatResponse(text="", json_data={"reason": "", "speech": None, "action": {"type": "design", "brief": "hut"}}, provider="m", model="m", usage=Usage()), known)
    assert not bad.ok and "brief" in bad.problems[0]


async def test_loop_runs_a_design_decision_and_remembers_the_building(tmp_path):
    world = FakeWorld()
    body_sim(world)
    loop, body, provider = await make_loop(tmp_path, world)
    spec = house_spec(w=5, d=5, h=3).model_dump()

    def brain(req: ChatRequest):
        if req.purpose == "decision" and "Woke by: build" in req.messages[-1].content:
            return {"reason": "I want a home", "speech": None, "action": {"type": "design", "brief": "a small oak cottage with a door, next to where I stand"}}
        if req.purpose == "design.critique":
            return {"score": 8.0, "problems": [], "improvements": [], "accept": True}
        if req.purpose.startswith("design."):
            return {"spec": spec, "rationale": "cottage"}
        return scripted_brain(req)

    provider.script = brain
    from emeth.builder.designer import Designer as D
    from emeth.cognition.construction import Constructor as C

    loop.constructor = C(D(loop.router, max_attempts=2), body)
    await loop.think("build")
    await wait_for_action_task(loop)
    assert world.actions[-1][0] == "build"
    assert sum(1 for r in provider.requests if r.purpose.startswith("design.")) == 2  # one design, one critique"
    kinds = [e.kind for e in loop.timeline.entries]
    assert "result" in kinds
    assert any(n.kind == "structure" for n in loop.graph.nodes_of()) and loop.identity.metrics.structures_built == 1
    assert any(p.kind == "project" for p in loop.store.list_pages())
    await body.close()
