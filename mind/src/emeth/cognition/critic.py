"""Critic — did the task actually succeed? Programmatic first, LLM only for fuzzy tasks (Voyager lesson)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from emeth.cognition.planner import Task, check_success
from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatRequest, Message
from emeth.memory.context import compact_observation
from emeth.protocol import Observation

CRITIC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "reasoning": {"type": "string"},
        "critique": {"type": "string", "description": "If not successful: what to do differently next time (concrete)."},
    },
    "required": ["success", "reasoning", "critique"],
}


@dataclass
class Verdict:
    success: bool
    reasoning: str
    critique: str = ""
    method: str = "programmatic"


class Critic:
    def __init__(self, router: LLMRouter | None = None):
        self.router = router

    async def verify(self, task: Task, before: Observation | None, after: Observation, result_summary: str, flags: dict[str, Any] | None = None) -> Verdict:
        if task.success:
            ok, why = check_success(task.success, after, flags)
            if ok:
                return Verdict(True, why)
            # programmatic says no — for inventory-type specs that is final
            if any(k in task.success for k in ("inventory", "inventory_any", "tool_tier", "food_points", "armor_pieces", "slept")):
                return Verdict(False, why, critique=f"Task not complete: {why}. Check the inventory delta in the result and gather what is missing before retrying.")
        if self.router is None:
            return Verdict(False, "no success spec and no critic model", method="none")
        delta = _inventory_delta(before, after) if before else {}
        prompt = (
            f"Task: {task.description}\n\n"
            f"Body report: {result_summary[:1500]}\n\n"
            f"Inventory delta since the task started: {json.dumps(delta, ensure_ascii=False)}\n"
            f"State now: {json.dumps(compact_observation(after), ensure_ascii=False)}\n\n"
            "Judge from evidence only (inventory for gather/craft, blocks nearby for build/place, hunger for eat). "
            "If the evidence is inconclusive, say success=false with a concrete critique."
        )
        req = ChatRequest(
            messages=[Message(role="system", content="You are a strict but fair Minecraft task judge. Never assume; verify from the state."), Message(role="user", content=prompt)],
            tier="fast",
            temperature=0.0,
            json_schema=CRITIC_SCHEMA,
            json_schema_name="verdict",
            purpose="critic",
        )
        try:
            resp = await self.router.chat(req)
        except Exception as exc:  # noqa: BLE001
            return Verdict(False, f"critic unavailable: {exc}", method="error")
        data = resp.json_data or {}
        return Verdict(bool(data.get("success")), str(data.get("reasoning", ""))[:400], str(data.get("critique", ""))[:400], method="llm")


def _inventory_delta(before: Observation, after: Observation) -> dict[str, int]:
    a = before.inventory.summary()
    b = after.inventory.summary()
    out: dict[str, int] = {}
    for k in set(a) | set(b):
        d = b.get(k, 0) - a.get(k, 0)
        if d:
            out[k] = d
    return out
