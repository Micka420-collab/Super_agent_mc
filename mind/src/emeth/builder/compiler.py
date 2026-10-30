"""Compile a StructureSpec into ordered block placements + bill of materials.

Later primitives overwrite earlier ones at the same cell (so `clear` after `box` carves rooms).
Air cells are kept in the blueprint (the body's `build` skips them, `clear_area` removes blocks).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from emeth.builder.dsl import Box, Clear, Door, Floor, Line, Pattern, Pillar, Roof, StructureSpec, Walls

Cell = tuple[int, int, int]


@dataclass
class Blueprint:
    name: str
    cells: dict[Cell, str]
    origin: tuple[int, int, int] = (0, 0, 0)

    @property
    def solid(self) -> dict[Cell, str]:
        return {c: b for c, b in self.cells.items() if b != "air"}

    @property
    def size(self) -> tuple[int, int, int]:
        if not self.cells:
            return (0, 0, 0)
        xs = [c[0] for c in self.cells]
        ys = [c[1] for c in self.cells]
        zs = [c[2] for c in self.cells]
        return (max(xs) - min(xs) + 1, max(ys) - min(ys) + 1, max(zs) - min(zs) + 1)

    def bill_of_materials(self) -> dict[str, int]:
        bom: dict[str, int] = {}
        for b in self.solid.values():
            bom[b] = bom.get(b, 0) + 1
        return dict(sorted(bom.items(), key=lambda kv: -kv[1]))

    def placements(self, origin: tuple[int, int, int] | None = None) -> list[dict[str, int | str]]:
        """World-space placements ordered bottom-up, nearest-first inside a layer."""
        ox, oy, oz = origin or self.origin
        rows: list[dict[str, int | str]] = [{"name": b, "x": ox + x, "y": oy + y, "z": oz + z} for (x, y, z), b in self.solid.items()]
        rows.sort(key=lambda r: (int(r["y"]), abs(int(r["x"]) - ox) + abs(int(r["z"]) - oz)))
        return rows

    def clear_boxes(self, origin: tuple[int, int, int] | None = None) -> list[tuple[Cell, Cell]]:
        """Bounding boxes of explicit air regions (interiors/doorways) in world space."""
        ox, oy, oz = origin or self.origin
        air = [c for c, b in self.cells.items() if b == "air"]
        if not air:
            return []
        xs = [c[0] for c in air]
        ys = [c[1] for c in air]
        zs = [c[2] for c in air]
        return [((ox + min(xs), oy + min(ys), oz + min(zs)), (ox + max(xs), oy + max(ys), oz + max(zs)))]

    def ascii_layers(self, max_layers: int = 12) -> str:
        """Top-down ASCII view per layer — cheap self-critique without a renderer."""
        if not self.cells:
            return "(empty)"
        xs = [c[0] for c in self.cells]
        ys = sorted({c[1] for c in self.cells})
        zs = [c[2] for c in self.cells]
        legend: dict[str, str] = {}
        glyphs = "#=+*%@&$~^!?ABCDEFGHJKLMNPQRSTUVWXYZ"
        out: list[str] = []
        for y in ys[:max_layers]:
            out.append(f"y={y}")
            for z in range(min(zs), max(zs) + 1):
                row = []
                for x in range(min(xs), max(xs) + 1):
                    b = self.cells.get((x, y, z))
                    if b is None or b == "air":
                        row.append(".")
                    else:
                        if b not in legend:
                            legend[b] = glyphs[len(legend) % len(glyphs)]
                        row.append(legend[b])
                out.append("".join(row))
        out.append("legend: " + ", ".join(f"{g}={b}" for b, g in legend.items()))
        return "\n".join(out)


@dataclass
class CompileReport:
    blueprint: Blueprint
    warnings: list[str] = field(default_factory=list)


def compile_structure(spec: StructureSpec, origin: tuple[int, int, int] = (0, 0, 0), max_blocks: int = 4096) -> CompileReport:
    cells: dict[Cell, str] = {}
    pal = spec.palette
    warnings: list[str] = []

    def put(x: int, y: int, z: int, block: str) -> None:
        cells[(x, y, z)] = pal.resolve(block)

    for p in spec.primitives:
        if isinstance(p, Box):
            for x in range(p.x, p.x + p.w):
                for y in range(p.y, p.y + p.h):
                    for z in range(p.z, p.z + p.d):
                        edge = x in (p.x, p.x + p.w - 1) or y in (p.y, p.y + p.h - 1) or z in (p.z, p.z + p.d - 1)
                        if p.hollow and not edge:
                            cells[(x, y, z)] = "air"
                        else:
                            put(x, y, z, p.block)
        elif isinstance(p, Floor):
            for x in range(p.x, p.x + p.w):
                for z in range(p.z, p.z + p.d):
                    block = p.block if (p.checker is None or (x + z) % 2 == 0) else p.checker
                    put(x, p.y, z, block)
        elif isinstance(p, Walls):
            x2, z2 = p.x + p.w - 1, p.z + p.d - 1
            for y in range(p.y, p.y + p.h):
                for x in range(p.x, x2 + 1):
                    for z in range(p.z, z2 + 1):
                        on_edge = x in (p.x, x2) or z in (p.z, z2)
                        if not on_edge:
                            cells.setdefault((x, y, z), "air")
                            continue
                        corner = (x in (p.x, x2)) and (z in (p.z, z2))
                        if corner and p.corner_block:
                            put(x, y, z, p.corner_block)
                            continue
                        is_window_row = p.window_y is not None and y == p.y + p.window_y and p.window_block
                        along = (x - p.x) if z in (p.z, z2) else (z - p.z)
                        if is_window_row and along % p.window_every == 1 and not corner:
                            put(x, y, z, p.window_block or p.block)
                        else:
                            put(x, y, z, p.block)
        elif isinstance(p, Roof):
            x1, x2 = p.x - p.overhang, p.x + p.w - 1 + p.overhang
            z1, z2 = p.z - p.overhang, p.z + p.d - 1 + p.overhang
            if p.style == "flat":
                for x in range(x1, x2 + 1):
                    for z in range(z1, z2 + 1):
                        put(x, p.y, z, p.block)
            elif p.style == "gable":
                # ridge runs along x; height rises from both z edges toward the middle
                depth = z2 - z1 + 1
                for z in range(z1, z2 + 1):
                    level = min(z - z1, z2 - z)
                    for x in range(x1, x2 + 1):
                        put(x, p.y + level, z, p.block)
                    # gable ends: fill the triangle under the roof at both x ends
                    if p.fill_gable:
                        for lvl in range(level):
                            put(x1 + p.overhang, p.y + lvl, z, "$wall")
                            put(x2 - p.overhang, p.y + lvl, z, "$wall")
                _ = depth
            else:  # hip / pyramid
                level = 0
                while x1 + level <= x2 - level and z1 + level <= z2 - level:
                    for x in range(x1 + level, x2 - level + 1):
                        for z in range(z1 + level, z2 - level + 1):
                            edge = x in (x1 + level, x2 - level) or z in (z1 + level, z2 - level)
                            if edge:
                                put(x, p.y + level, z, p.block)
                    level += 1
        elif isinstance(p, Pillar):
            for y in range(p.y, p.y + p.h):
                put(p.x, y, p.z, p.block)
        elif isinstance(p, Door):
            cells[(p.x, p.y, p.z)] = "air"
            cells[(p.x, p.y + 1, p.z)] = "air"
            if p.block:
                put(p.x, p.y, p.z, p.block)  # the body places the lower half; the game adds the upper half
        elif isinstance(p, Line):
            steps = max(abs(p.x2 - p.x1), abs(p.y2 - p.y1), abs(p.z2 - p.z1), 1)
            for i in range(steps + 1):
                t = i / steps
                put(round(p.x1 + (p.x2 - p.x1) * t), round(p.y1 + (p.y2 - p.y1) * t), round(p.z1 + (p.z2 - p.z1) * t), p.block)
        elif isinstance(p, Pattern):
            for i in range(p.count):
                put(p.x + p.dx * i, p.y + p.dy * i, p.z + p.dz * i, p.block)
        elif isinstance(p, Clear):
            for x in range(p.x, p.x + p.w):
                for y in range(p.y, p.y + p.h):
                    for z in range(p.z, p.z + p.d):
                        cells[(x, y, z)] = "air"

    bp = Blueprint(name=spec.name, cells=cells, origin=origin)
    solid = len(bp.solid)
    if solid > max_blocks:
        warnings.append(f"structure has {solid} blocks, above the {max_blocks} limit — split it or shrink it")
    if solid == 0:
        warnings.append("structure has no solid blocks")
    # floating check: any solid block with nothing below and nothing beside is suspicious
    floating = 0
    for (x, y, z), _b in bp.solid.items():
        if y == min(c[1] for c in cells):
            continue
        if (x, y - 1, z) not in bp.solid and not any((x + dx, y, z + dz) in bp.solid for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            floating += 1
    if floating:
        warnings.append(f"{floating} blocks have no support below or beside them (may be hard to place)")
    return CompileReport(bp, warnings)


def house_spec(name: str = "small house", w: int = 7, d: int = 7, h: int = 4, palette_overrides: dict[str, str] | None = None) -> StructureSpec:
    """A sensible default cottage: floor, walls with windows, door, gable roof, torches inside."""
    from emeth.builder.dsl import Palette

    pal = Palette.model_validate(palette_overrides or {})
    primitives: list[object] = [
        Floor(x=0, y=0, z=0, w=w, d=d, block="$floor"),
        Walls(x=0, y=1, z=0, w=w, h=h, d=d, block="$wall", window_y=2, window_every=2, corner_block="$pillar"),
        Door(x=w // 2, y=1, z=0, block="$door", facing="north"),
        Roof(x=0, y=h + 1, z=0, w=w, d=d, style="gable", block="$roof_block", overhang=1),
        Pattern(x=1, y=3, z=1, count=2, dx=w - 3, block="$light"),
        Pattern(x=1, y=3, z=d - 2, count=2, dx=w - 3, block="$light"),
    ]
    return StructureSpec(name=name, description="a cosy cottage", palette=pal, primitives=primitives, viewpoint=(w // 2, 1, -6))  # type: ignore[arg-type]
