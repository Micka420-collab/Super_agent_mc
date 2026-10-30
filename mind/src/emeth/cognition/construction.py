"""Construction — from a one-line brief to blocks in the world, with every risky step checked first.

    brief ──► Designer (DSL spec → blueprint, self-critiqued) ──► site survey (`surface_height`)
          ──► anchor the blueprint in front of the agent ──► `plan_build` dry run (support, enclosure, materials)
          ──► `build {procure: true, partial: true}` (the body fetches missing materials through the planner)
          ──► memory: a place node + a project page, and an honest summary for the critic.

The LLM only chooses *what* to build (`action.type = "design"` with a brief); everything after that is deterministic
or verified, so a vague wish never turns into a half-placed pile of blocks nobody can explain.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

from emeth.bridge.client import BodyClient
from emeth.builder.designer import Designer, DesignResult
from emeth.protocol import ActionResult, BodyError, Observation

log = logging.getLogger(__name__)

ProgressFn = Any  # Callable[[str], None] | None — kept loose for the loop's convenience


@dataclass
class ConstructionOutcome:
    brief: str
    ok: bool
    design: DesignResult | None = None
    origin: tuple[int, int, int] | None = None
    dry_run: dict[str, Any] | None = None
    build: ActionResult | None = None
    error: str = ""
    notes: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return (self.design.blueprint.name if self.design and self.design.blueprint else "structure") or "structure"

    def summary(self) -> str:
        if self.error and not self.build:
            return f"construction '{self.brief}' failed: {self.error}"
        parts = [f"built '{self.name}' at {self.origin}" if self.ok else f"construction '{self.name}' incomplete"]
        if self.build and isinstance(self.build.result, dict):
            r = self.build.result
            parts.append(f"placed {r.get('placed', 0)}/{r.get('planned', '?')} blocks, {r.get('failureCount', 0)} failed, {r.get('alreadyCorrect', 0)} already there")
            if r.get("missing"):
                parts.append("still missing: " + ", ".join(f"{c} {n}" for n, c in dict(r["missing"]).items()))
        if self.dry_run and self.dry_run.get("unsupported"):
            parts.append(f"{len(self.dry_run['unsupported'])} blocks of the design would float and were skipped")
        if self.error:
            parts.append(self.error)
        return "; ".join(parts)


def facing_vector(yaw: float) -> tuple[float, float]:
    """Mineflayer convention: dx = -sin(yaw), dz = -cos(yaw)."""
    return (-math.sin(yaw), -math.cos(yaw))


def choose_origin(obs: Observation, size: tuple[int, int, int], ground_y: int, clearance: int = 3) -> tuple[int, int, int]:
    """Footprint centred a few blocks ahead of the agent, standing on the surveyed ground."""
    dx, dz = facing_vector(obs.self_.yaw)
    sx, _sy, sz = size
    reach = clearance + max(sx, sz) / 2
    cx = obs.self_.position.x + dx * reach
    cz = obs.self_.position.z + dz * reach
    return (int(math.floor(cx - sx / 2)), ground_y + 1, int(math.floor(cz - sz / 2)))


class Constructor:
    def __init__(self, designer: Designer, body: BodyClient, *, max_size: tuple[int, int, int] = (12, 8, 12)):
        self.designer = designer
        self.body = body
        self.max_size = max_size

    async def build_from_brief(self, brief: str, obs: Observation, *, size: tuple[int, int, int] | None = None, progress: ProgressFn = None) -> ConstructionOutcome:
        out = ConstructionOutcome(brief=brief, ok=False)
        say = progress or (lambda _m: None)
        limit = tuple(min(a, b) for a, b in zip(size or self.max_size, self.max_size, strict=True))
        max_size = (int(limit[0]), int(limit[1]), int(limit[2]))

        # 1. site survey where the structure will stand
        dx, dz = facing_vector(obs.self_.yaw)
        probe_x = int(round(obs.self_.position.x + dx * (3 + max_size[0] / 2)))
        probe_z = int(round(obs.self_.position.z + dz * (3 + max_size[2] / 2)))
        radius = max(2, min(16, max(max_size[0], max_size[2]) // 2 + 1))
        try:
            survey = await self.body.act("surface_height", {"x": probe_x, "z": probe_z, "radius": radius})
        except BodyError as exc:
            out.error = f"site survey failed: {exc.message}"
            return out
        sv = survey.result if isinstance(survey.result, dict) else {}
        heights = [h for row in sv.get("heights", []) for h in (row if isinstance(row, list) else [row]) if isinstance(h, (int, float))]
        ground_y = int(sorted(heights)[len(heights) // 2]) if heights else int(math.floor(obs.self_.position.y)) - 1
        roughness = int(sv.get("roughness", 0) or 0)
        surface = sv.get("surfaceBlocks") or {}
        site = f"Ground level y={ground_y} (median) around ({probe_x}, {probe_z}); terrain roughness {roughness} blocks over a radius of {radius}; surface: {', '.join(f'{k} ×{v}' for k, v in list(dict(surface).items())[:4]) or obs.blocks.standingOn}; biome {obs.self_.biome}."
        if roughness > 3:
            out.notes.append(f"rough site (Δh={roughness}): the design should include a raised floor or the site needs levelling")
            site += " The ground is uneven: start with a floor/foundation layer."
        say(f"surveyed the site: {site}")

        # 2. design with what we carry in mind (the body can procure the rest, but keep it modest)
        materials = obs.inventory.summary()
        out.design = await self.designer.design(brief, site=site, materials=materials or None, max_size=max_size, strict_budget=False)
        if not out.design.ok or out.design.blueprint is None:
            out.error = f"could not design it: {out.design.error or 'no acceptable design'}"
            return out
        bp = out.design.blueprint
        out.origin = choose_origin(obs, bp.size, ground_y)
        blocks = bp.placements(out.origin)
        if not blocks:
            out.error = "the design is empty"
            return out
        say(f"designed '{bp.name}' ({bp.size[0]}×{bp.size[1]}×{bp.size[2]}, {len(blocks)} blocks), checking the site")

        # 3. dry run: support, enclosure, occupied cells, materials
        try:
            dry = await self.body.act("plan_build", {"blocks": blocks})
        except BodyError as exc:
            out.error = f"dry run failed: {exc.message}"
            return out
        out.dry_run = dry.result if isinstance(dry.result, dict) else {}
        order = out.dry_run.get("order") or []
        if not order:
            out.error = f"nothing of the design can be placed here: {out.dry_run.get('text', '')}"
            return out
        if out.dry_run.get("occupied"):
            out.notes.append(f"{len(out.dry_run['occupied'])} cells are occupied by existing blocks and will be left alone")
        say(f"dry run: {out.dry_run.get('text', '')}")

        # 4. build for real — the body procures what is missing, places what it can, reports the rest
        try:
            out.build = await self.body.act("build", {"blocks": order, "procure": True, "partial": True}, timeout_ms=1_800_000)
        except BodyError as exc:
            out.error = f"build failed before starting: {exc.message}"
            return out
        r = out.build.result if isinstance(out.build.result, dict) else {}
        placed = int(r.get("placed", 0) or 0) + int(r.get("alreadyCorrect", 0) or 0)
        out.ok = bool(out.build.ok) and placed >= max(1, int(0.8 * len(order)))
        if out.build.ok and not out.ok:
            out.error = f"only {placed}/{len(order)} blocks are in place"
        elif not out.build.ok:
            out.error = out.build.error or "build failed"
        return out
