"""Designer — from a brief + site survey to a validated StructureSpec, with a critique loop.

Creative building is the weakest spot of every public agent (MC-Bench, MineCEraft). We attack it on
three fronts: a constrained grammar the model can't get wrong, an ASCII self-critique pass that costs
no renderer, and an optional pixel critique through the body's retina for a vision model.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from emeth.builder.compiler import Blueprint, compile_structure
from emeth.builder.dsl import StructureSpec
from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatRequest, ImagePart, Message

DESIGN_SYSTEM = """You are the architect inside an autonomous Minecraft player. You design structures as JSON using a
parametric grammar (primitives: box, floor, walls, roof, pillar, door, line, pattern, clear). Coordinates are relative
to the build origin (x east, y up from the ground level y=0, z south). Palette references start with `$` ($wall,
$floor, $roof_block, $pillar, $window, $door, $light, $accent, $fence, $slab, $path, or $<extra key>).
Design principles: a real floor at y=0, walls from y=1, a door at y=1 on an outer wall, windows in the wall's second row,
a roof above the walls with overhang 1, lights inside, a clear interior (walls do this automatically). Prefer 2-3
materials with one accent; respect the material budget; nothing floating. Keep it within the size limits given."""

SPEC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "spec": {"type": "object", "description": "StructureSpec JSON: {name, description, palette:{...}, primitives:[...], viewpoint:[x,y,z]}"},
        "rationale": {"type": "string"},
    },
    "required": ["spec", "rationale"],
}

CRITIQUE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "score": {"type": "number", "description": "0-10 overall quality"},
        "problems": {"type": "array", "items": {"type": "string"}},
        "improvements": {"type": "array", "items": {"type": "string"}},
        "accept": {"type": "boolean"},
    },
    "required": ["score", "problems", "improvements", "accept"],
}


@dataclass
class DesignResult:
    spec: StructureSpec | None
    blueprint: Blueprint | None
    attempts: int
    critiques: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.blueprint is not None and not self.error


class Designer:
    def __init__(self, router: LLMRouter, *, max_attempts: int = 3, accept_score: float = 6.5):
        self.router = router
        self.max_attempts = max_attempts
        self.accept_score = accept_score

    async def design(self, brief: str, *, site: str = "", materials: dict[str, int] | None = None, max_size: tuple[int, int, int] = (12, 8, 12), retina_png_b64: str | None = None) -> DesignResult:
        feedback = ""
        critiques: list[dict[str, Any]] = []
        last_error = ""
        for attempt in range(1, self.max_attempts + 1):
            prompt = self._prompt(brief, site, materials, max_size, feedback)
            req = ChatRequest(messages=[Message(role="system", content=DESIGN_SYSTEM), Message(role="user", content=prompt)], tier="smart", temperature=0.6, max_tokens=3500, json_schema=SPEC_SCHEMA, json_schema_name="design", purpose=f"design.{attempt}")
            try:
                resp = await self.router.chat(req)
            except Exception as exc:  # noqa: BLE001
                return DesignResult(None, None, attempt, critiques, error=f"model error: {exc}")
            raw = (resp.json_data or {}).get("spec")
            if not isinstance(raw, dict):
                feedback = "Your answer did not contain a `spec` object. Return {spec: {...}, rationale: ...}."
                last_error = feedback
                continue
            try:
                spec = StructureSpec.model_validate(raw)
            except ValidationError as exc:
                feedback = "The spec failed validation:\n" + "\n".join(f"- {e['loc']}: {e['msg']}" for e in exc.errors()[:12]) + "\nFix it and return the whole spec again."
                last_error = feedback
                continue
            report = compile_structure(spec)
            bp = report.blueprint
            sx, sy, sz = bp.size
            problems = list(report.warnings)
            if sx > max_size[0] or sy > max_size[1] or sz > max_size[2]:
                problems.append(f"size {sx}x{sy}x{sz} exceeds the limit {max_size[0]}x{max_size[1]}x{max_size[2]}")
            if materials:
                bom = bp.bill_of_materials()
                short = {b: n - materials.get(b, 0) for b, n in bom.items() if materials.get(b, 0) < n}
                if short:
                    problems.append("material budget exceeded: " + ", ".join(f"{b} short by {n}" for b, n in list(short.items())[:6]))
            critique = await self._critique(brief, spec, bp, problems, retina_png_b64)
            critiques.append(critique)
            if critique.get("accept") and not problems:
                return DesignResult(spec, bp, attempt, critiques)
            feedback = "Critique of the previous design (score {score}/10):\n- ".format(score=critique.get("score", "?")) + "\n- ".join(problems + [str(p) for p in critique.get("problems", [])] + [f"improve: {i}" for i in critique.get("improvements", [])]) + "\nReturn an improved complete spec."
            last_spec, last_bp = spec, bp
        # out of attempts: return the last compilable design if any
        if "last_bp" in locals():
            return DesignResult(last_spec, last_bp, self.max_attempts, critiques)  # type: ignore[possibly-undefined]
        return DesignResult(None, None, self.max_attempts, critiques, error=last_error or "no valid design")

    def _prompt(self, brief: str, site: str, materials: dict[str, int] | None, max_size: tuple[int, int, int], feedback: str) -> str:
        parts = [f"# Brief\n{brief}", f"# Limits\nMax size {max_size[0]} wide (x) × {max_size[1]} high (y) × {max_size[2]} deep (z); max 1200 blocks."]
        if site:
            parts.append(f"# Site survey\n{site}")
        if materials:
            parts.append("# Materials available\n" + ", ".join(f"{b}×{n}" for b, n in sorted(materials.items(), key=lambda kv: -kv[1])[:30]))
        parts.append(
            "# Example spec\n"
            + json.dumps(
                {
                    "name": "fisher hut",
                    "description": "a tiny spruce hut by the water",
                    "palette": {"wall": "spruce_planks", "floor": "spruce_planks", "roof_block": "dark_oak_planks", "pillar": "spruce_log", "window": "glass_pane", "door": "spruce_door", "light": "torch"},
                    "primitives": [
                        {"op": "floor", "x": 0, "y": 0, "z": 0, "w": 5, "d": 5},
                        {"op": "walls", "x": 0, "y": 1, "z": 0, "w": 5, "h": 3, "d": 5, "window_y": 1},
                        {"op": "door", "x": 2, "y": 1, "z": 0, "facing": "north"},
                        {"op": "roof", "x": 0, "y": 4, "z": 0, "w": 5, "d": 5, "style": "gable", "overhang": 1},
                        {"op": "pattern", "x": 1, "y": 3, "z": 1, "count": 2, "dx": 2, "block": "$light"},
                    ],
                    "viewpoint": [2, 1, -5],
                },
                ensure_ascii=False,
            )
        )
        if feedback:
            parts.append(f"# Feedback\n{feedback}")
        return "\n\n".join(parts)

    async def _critique(self, brief: str, spec: StructureSpec, bp: Blueprint, problems: list[str], retina_png_b64: str | None) -> dict[str, Any]:
        layers = bp.ascii_layers(max_layers=10)
        prompt = (
            f"Brief: {brief}\nDesign name: {spec.name} — {spec.description}\nSize: {bp.size}, blocks: {len(bp.solid)}\n"
            f"Compiler warnings: {problems or 'none'}\n\nTop-down layers (one grid per y level):\n{layers}\n\n"
            "Judge as a picky Minecraft builder: does it have a floor, enclosed walls, a door, windows, a roof that covers the walls, interior light, "
            "pleasant proportions and a bit of character? Score 0-10, list concrete problems and improvements, accept only if ≥ 6.5 and buildable."
        )
        images = [ImagePart(media_type="image/png", data_base64=retina_png_b64)] if retina_png_b64 else []
        req = ChatRequest(messages=[Message(role="system", content="You are a demanding Minecraft build critic. Be concrete."), Message(role="user", content=prompt, images=images)], tier="vision" if images else "fast", temperature=0.2, json_schema=CRITIQUE_SCHEMA, json_schema_name="critique", purpose="design.critique")
        try:
            resp = await self.router.chat(req)
            data = resp.json_data or {}
        except Exception as exc:  # noqa: BLE001
            return {"score": 0, "problems": [f"critic unavailable: {exc}"], "improvements": [], "accept": not problems}
        if not isinstance(data, dict):
            return {"score": 0, "problems": ["critic returned no JSON"], "improvements": [], "accept": not problems}
        data.setdefault("accept", float(data.get("score", 0)) >= self.accept_score)
        return data
