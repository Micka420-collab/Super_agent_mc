"""Structure DSL — a small parametric building grammar the LLM writes instead of raw coordinates.

Primitives compose into a `StructureSpec`; the compiler turns them into ordered block placements
with a bill of materials. The grammar keeps the model honest (every shape is closed-form and
validated) while leaving room for creativity through palettes, patterns and transforms.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

BlockName = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_:]+$")]
# A concrete block name or a palette reference such as "$wall".
BlockRef = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^(\$[a-z_]+|[a-z0-9_:]+)$")]


class Palette(BaseModel):
    """Named materials so a design can be re-skinned (oak → spruce) without touching geometry."""

    wall: BlockName = "oak_planks"
    floor: BlockName = "oak_planks"
    roof: BlockName = "oak_stairs"
    roof_block: BlockName = "oak_planks"
    pillar: BlockName = "oak_log"
    window: BlockName = "glass_pane"
    door: BlockName = "oak_door"
    light: BlockName = "torch"
    accent: BlockName = "stripped_oak_log"
    fence: BlockName = "oak_fence"
    slab: BlockName = "oak_slab"
    path: BlockName = "cobblestone"
    extra: dict[str, BlockName] = Field(default_factory=dict)

    def resolve(self, ref: str) -> str:
        if ref.startswith("$"):
            key = ref[1:]
            if key in self.extra:
                return self.extra[key]
            return getattr(self, key, key)
        return ref


class Box(BaseModel):
    """Filled or hollow axis-aligned box. Origin-relative coordinates (x east, y up, z south)."""

    op: Literal["box"] = "box"
    x: int
    y: int
    z: int
    w: int = Field(ge=1, le=64)
    h: int = Field(ge=1, le=64)
    d: int = Field(ge=1, le=64)
    block: BlockRef = "$wall"
    hollow: bool = False


class Floor(BaseModel):
    op: Literal["floor"] = "floor"
    x: int
    y: int
    z: int
    w: int = Field(ge=1, le=64)
    d: int = Field(ge=1, le=64)
    block: BlockRef = "$floor"
    checker: BlockRef | None = None  # second block for a checkerboard


class Walls(BaseModel):
    """Four walls of a rectangle (interior left empty), optional window rows."""

    op: Literal["walls"] = "walls"
    x: int
    y: int
    z: int
    w: int = Field(ge=3, le=64)
    h: int = Field(ge=1, le=32)
    d: int = Field(ge=3, le=64)
    block: BlockRef = "$wall"
    window_block: BlockRef | None = "$window"
    window_y: int | None = 1  # relative row for windows, None = no windows
    window_every: int = Field(default=2, ge=1, le=8)
    corner_block: BlockRef | None = "$pillar"


class Roof(BaseModel):
    """Gable (pitched, along the x axis), hip (pyramid), or flat (slab) roof covering a footprint."""

    op: Literal["roof"] = "roof"
    x: int
    y: int
    z: int
    w: int = Field(ge=3, le=64)
    d: int = Field(ge=3, le=64)
    style: Literal["gable", "hip", "flat"] = "gable"
    block: BlockRef = "$roof_block"
    overhang: int = Field(default=1, ge=0, le=2)
    fill_gable: bool = True


class Pillar(BaseModel):
    op: Literal["pillar"] = "pillar"
    x: int
    y: int
    z: int
    h: int = Field(ge=1, le=64)
    block: BlockRef = "$pillar"


class Door(BaseModel):
    """A 2-high opening (optionally with a real door item) in a wall."""

    op: Literal["door"] = "door"
    x: int
    y: int
    z: int
    block: BlockRef | None = "$door"
    facing: Literal["north", "south", "east", "west"] = "south"


class Line(BaseModel):
    op: Literal["line"] = "line"
    x1: int
    y1: int
    z1: int
    x2: int
    y2: int
    z2: int
    block: BlockRef = "$fence"


class Pattern(BaseModel):
    """Repeat a block along one axis with a stride (torches on a wall, fence posts, pillars)."""

    op: Literal["pattern"] = "pattern"
    x: int
    y: int
    z: int
    count: int = Field(ge=1, le=64)
    dx: int = 0
    dy: int = 0
    dz: int = 0
    block: BlockRef = "$light"


class Clear(BaseModel):
    """Mark a box as air (interior rooms, doorways)."""

    op: Literal["clear"] = "clear"
    x: int
    y: int
    z: int
    w: int = Field(ge=1, le=64)
    h: int = Field(ge=1, le=64)
    d: int = Field(ge=1, le=64)


Primitive = Annotated[Box | Floor | Walls | Roof | Pillar | Door | Line | Pattern | Clear, Field(discriminator="op")]


class StructureSpec(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    palette: Palette = Field(default_factory=Palette)
    primitives: list[Primitive] = Field(min_length=1, max_length=200)
    # Where the agent should stand when the build is done (origin-relative), for the final look.
    viewpoint: tuple[int, int, int] | None = None

    @model_validator(mode="after")
    def _bounds(self) -> StructureSpec:
        # keep structures within a sane envelope (the body builds at most 4096 blocks per call)
        for p in self.primitives:
            for attr in ("x", "y", "z", "x1", "x2", "z1", "z2"):
                v = getattr(p, attr, None)
                if v is not None and abs(v) > 128:
                    raise ValueError(f"{p.op}: coordinate {attr}={v} out of range (±128)")
            for attr in ("y1", "y2"):
                v = getattr(p, attr, None)
                if v is not None and not -64 <= v <= 128:
                    raise ValueError(f"{p.op}: {attr}={v} out of range")
        return self
