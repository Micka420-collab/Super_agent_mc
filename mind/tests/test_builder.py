import pytest
from pydantic import ValidationError

from emeth.builder.compiler import compile_structure, house_spec
from emeth.builder.designer import Designer
from emeth.builder.dsl import Box, Palette, Roof, StructureSpec, Walls
from emeth.llm.mock import MockProvider
from emeth.llm.router import LLMRouter


def test_house_compiles_with_floor_walls_door_roof_and_bom():
    spec = house_spec(w=7, d=7, h=4)
    report = compile_structure(spec, origin=(100, 64, -20))
    bp = report.blueprint
    assert not [w for w in report.warnings if "no solid" in w]
    bom = bp.bill_of_materials()
    assert bom["oak_planks"] > 40 and "glass_pane" in bom and "oak_door" in bom and "torch" in bom
    placements = bp.placements()
    # bottom-up ordering, world coordinates offset by the origin
    assert placements[0]["y"] == 64 and placements[-1]["y"] > 64
    assert all(99 <= p["x"] <= 107 for p in placements)  # type: ignore[operator]  # overhang adds one block each side
    # the interior is air (walls primitive clears it) and the door cell holds the door, not planks
    assert bp.cells[(3, 1, 3)] == "air"
    assert bp.cells[(3, 1, 0)] == "oak_door" and bp.cells[(3, 2, 0)] == "air"
    layers = bp.ascii_layers()
    assert "y=0" in layers and "legend:" in layers
    size = bp.size
    assert size[0] == 9 and size[2] == 9  # overhang adds one on each side


def test_roof_styles_and_palette_resolution():
    pal = Palette(roof_block="spruce_planks", extra={"trim": "stripped_spruce_log"})
    spec = StructureSpec(name="r", palette=pal, primitives=[Roof(x=0, y=0, z=0, w=5, d=5, style="hip", overhang=0), Box(x=0, y=-1, z=0, w=1, h=1, d=1, block="$trim")])
    bp = compile_structure(spec).blueprint
    assert bp.cells[(0, -1, 0)] == "stripped_spruce_log"
    assert bp.cells[(2, 2, 2)] == "spruce_planks"  # pyramid apex
    gable = compile_structure(StructureSpec(name="g", primitives=[Roof(x=0, y=0, z=0, w=4, d=5, style="gable", overhang=0, fill_gable=False)])).blueprint
    assert gable.cells[(0, 2, 2)] == "oak_planks" and gable.cells[(0, 0, 0)] == "oak_planks"


def test_dsl_validation_rejects_bad_input():
    with pytest.raises(ValidationError):
        StructureSpec(name="x", primitives=[])
    with pytest.raises(ValidationError):
        StructureSpec(name="x", primitives=[Walls(x=0, y=0, z=0, w=2, h=1, d=2)])  # w < 3
    with pytest.raises(ValidationError):
        StructureSpec.model_validate({"name": "x", "primitives": [{"op": "box", "x": 500, "y": 0, "z": 0, "w": 1, "h": 1, "d": 1}]})
    with pytest.raises(ValidationError):
        StructureSpec.model_validate({"name": "x", "primitives": [{"op": "floor", "x": 0, "y": 0, "z": 0, "w": 2, "d": 2, "block": "Oak Planks!"}]})


def test_compiler_warns_on_floating_blocks():
    spec = StructureSpec(name="f", primitives=[Box(x=0, y=0, z=0, w=1, h=1, d=1), Box(x=5, y=6, z=5, w=1, h=1, d=1)])
    report = compile_structure(spec)
    assert any("no support" in w for w in report.warnings)


async def test_designer_iterates_until_critic_accepts():
    spec = house_spec(w=5, d=5, h=3).model_dump()
    responses = [
        {"spec": {"name": "bad", "primitives": []}, "rationale": "oops"},  # invalid → validation feedback
        {"spec": spec, "rationale": "cottage"},
        {"score": 8.5, "problems": [], "improvements": [], "accept": True},
    ]
    router = LLMRouter([MockProvider("m", responses=responses)])
    designer = Designer(router, max_attempts=3)
    result = await designer.design("a small cottage", max_size=(12, 8, 12))
    assert result.ok and result.blueprint is not None
    assert result.attempts == 2 and result.critiques[0]["accept"]
    assert "oak_door" in result.blueprint.bill_of_materials()
    # the first retry prompt carried validation feedback
    second_prompt = router.providers["m"].requests[1].messages[-1].content  # type: ignore[attr-defined]
    assert "failed validation" in second_prompt
