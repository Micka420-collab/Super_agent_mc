"""Skill synthesis — turn a goal into a verified program (Voyager loop, hardened).

1. Retrieve similar skills from the library; reuse one when it fits and has a good record.
2. Otherwise ask the `code` tier to write `async function main(api, args)` against the body's API doc,
   with the retrieved skills as examples and the current observation as context.
3. Static check on the body (`skill.check`), run in the sandbox, feed errors + trace back, max N attempts.
4. On success the critic verifies; the skill is stored with a description for future retrieval.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from emeth.bridge.client import BodyClient
from emeth.llm.base import FREE_ARGS_NOTE, free_args
from emeth.llm.router import LLMRouter
from emeth.llm.types import ChatRequest, Message
from emeth.memory.context import render_blocks, render_inventory, render_sensory
from emeth.memory.procedural import Skill, SkillLibrary, safe_skill_name
from emeth.protocol import Observation, SkillRunResult

CODE_BLOCK = re.compile(r"```(?:javascript|js)?\s*(.*?)```", re.DOTALL)

SKILL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "plan": {"type": "string", "description": "Numbered plan in a few lines."},
        "name": {"type": "string", "description": "snake_case skill name describing the reusable capability (e.g. mine_logs_nearby)."},
        "description": {"type": "string", "description": "One or two sentences: what the skill does, its args, when to use it."},
        "code": {"type": "string", "description": "Complete JavaScript source defining async function main(api, args)."},
        "args_json": {"type": "string", "description": "Arguments to run it with now: " + FREE_ARGS_NOTE},
    },
    "required": ["plan", "name", "description", "code", "args_json"],
}

# No "think step by step" here: under structured output that free-text reasoning has nowhere to go and burnt the whole
# token budget (live: three syntheses in a row cut at 4000 tokens with an empty or `{"plan` answer). The plan field is
# where the thinking goes.
SKILL_SYSTEM = "You write robust Mineflayer-style skill programs for an autonomous Minecraft player. Answer with the JSON object only; reason in its `plan` field."

SKILL_RULES = """Rules for skill code:
- Define `async function main(api, args)`; everything happens inside it (helpers allowed). Return a small JSON-serialisable summary.
- Only use `api.<primitive>({...})` calls from the API doc plus helpers api.log/api.sleep/api.observe/api.Vec3/api.distance/api.aborted.
  Every primitive takes ONE object argument and returns a result or throws an error with `.code` (MISSING_ITEM, NOT_FOUND, NO_PATH, TIMEOUT, INTERRUPTED...).
- Check the inventory/world before acting and after acting (api.observe()); do not assume success.
- Prefer high-level primitives (mine, craft, smelt, build, goto) over micro-moves. Use api.find_blocks before api.mine when a specific block matters.
- Bound every loop (max iterations) and stop early when `api.aborted()` is true. No infinite loops, no timers, no require/import/process.
- Handle MISSING_ITEM by gathering/crafting prerequisites when reasonable; otherwise throw a clear error explaining what is missing.
- Keep the skill generic and reusable through `args` (counts, names, positions) — it will be stored in a library."""


@dataclass
class SkillOutcome:
    ok: bool
    skill: Skill | None
    result: SkillRunResult | None
    attempts: int
    error: str = ""
    reused: bool = False
    transcript: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if self.ok and self.result:
            return f"skill {self.skill.name if self.skill else '?'} succeeded: {json.dumps(self.result.result, ensure_ascii=False)[:600]}"
        return f"skill failed after {self.attempts} attempt(s): {self.error[:400]}"


class SkillSynthesizer:
    def __init__(self, router: LLMRouter, body: BodyClient, library: SkillLibrary, *, max_attempts: int = 4, run_timeout_ms: int = 180_000):
        self.router = router
        self.body = body
        self.library = library
        self.max_attempts = max_attempts
        self.run_timeout_ms = run_timeout_ms

    async def accomplish(self, goal: str, obs: Observation, *, context_hint: str = "", progress=None) -> SkillOutcome:  # type: ignore[no-untyped-def]
        transcript: list[str] = []
        res: SkillRunResult | None = None
        similar = await self.library.retrieve(goal, limit=4)
        # 1. reuse a proven skill when it is a very close match
        for s in similar:
            if s.record and s.record.uses >= 2 and s.record.success_rate >= 0.6 and s.record.score >= 0.75:
                reuse_args = await self._args_for(s, goal, obs)
                res = await self.body.run_skill(s.name, s.code, reuse_args, timeout_ms=self.run_timeout_ms)
                self.library.record_outcome(s.name, res.ok, res.finishedAt - res.startedAt)
                transcript.append(f"reused {s.name}: {'ok' if res.ok else res.error}")
                if res.ok:
                    return SkillOutcome(True, s, res, 1, reused=True, transcript=transcript)
                break  # fall through to synthesis with the failure as context
        # 2. synthesise
        api_doc = self.body.hello.skillApiDoc if self.body.hello else ""
        examples = self.library.describe_for_prompt(similar, max_chars=5000)
        feedback = ""
        last_name = safe_skill_name(goal)
        for attempt in range(1, self.max_attempts + 1):
            prompt = self._prompt(goal, obs, api_doc, examples, feedback, context_hint)
            req = ChatRequest(messages=[Message(role="system", content=SKILL_SYSTEM), Message(role="user", content=prompt)], tier="code", temperature=0.2, max_tokens=6000, json_schema=SKILL_SCHEMA, json_schema_name="skill", purpose=f"skill.synthesis.{attempt}")
            try:
                resp = await self.router.chat(req)
            except Exception as exc:  # noqa: BLE001
                transcript.append(f"attempt {attempt}: model error {exc}")
                return SkillOutcome(False, None, None, attempt, error=f"model error: {exc}", transcript=transcript)
            data = resp.json_data or {}
            code = str(data.get("code") or "")
            m = CODE_BLOCK.search(code)
            if m:
                code = m.group(1)
            if resp.finish_reason in ("length", "max_tokens"):
                feedback = "Your previous answer was cut off at the length limit before the code was complete. Keep `plan` to a few lines and write shorter code (one job, no speculative helpers)."
                transcript.append(f"attempt {attempt}: answer truncated at the token limit")
                continue
            if not code.strip():
                feedback = "Your previous answer contained no code. Return the full JavaScript source in the `code` field."
                transcript.append(f"attempt {attempt}: empty code")
                continue
            last_name = safe_skill_name(str(data.get("name") or last_name))
            args: dict[str, Any] = free_args(data)
            check = await self.body.check_skill(code)
            if not check.ok:
                feedback = "Static check rejected the code:\n- " + "\n- ".join(check.problems) + "\nFix these problems and return the complete code again."
                transcript.append(f"attempt {attempt}: rejected ({'; '.join(check.problems)[:200]})")
                continue
            if progress:
                await progress(f"running skill {last_name} (attempt {attempt})")
            res = await self.body.run_skill(last_name, code, args, timeout_ms=self.run_timeout_ms)
            transcript.append(f"attempt {attempt}: {'ok' if res.ok else res.error} — trace {[t.call for t in res.trace][:12]}")
            if res.ok:
                skill = await self.library.add(last_name, code, str(data.get("description") or goal), tags=["auto", "verified"])
                self.library.record_outcome(skill.name, True, res.finishedAt - res.startedAt)
                return SkillOutcome(True, skill, res, attempt, transcript=transcript)
            if res.errorCode == "INTERRUPTED":
                return SkillOutcome(False, None, res, attempt, error=f"interrupted: {res.interruptedBy or res.error}", transcript=transcript)
            trace = "\n".join(f"  {t.call}: {'ok' if t.ok else t.error}" for t in res.trace[-12:])
            logs = "\n".join(res.logs[-10:])
            feedback = f"Execution failed with {res.errorCode}: {res.error}\nCall trace:\n{trace}\nLogs:\n{logs}\nFix the code (or adapt the approach) and return the complete source again."
        return SkillOutcome(False, None, res, self.max_attempts, error=(res.error if res else "no result") or "unknown", transcript=transcript)

    async def _args_for(self, skill: Skill, goal: str, obs: Observation) -> dict[str, Any]:
        """Ask the fast tier to fill the args of a reusable skill for this goal (cheap, structured)."""
        schema = {"type": "object", "properties": {"args_json": {"type": "string", "description": FREE_ARGS_NOTE}}, "required": ["args_json"]}
        prompt = f"Goal: {goal}\nSkill `{skill.name}`: {skill.description}\nCode:\n{skill.code[:3000]}\nInventory: {render_inventory(obs)}\nReturn the args object to call main(api, args) with."
        try:
            resp = await self.router.chat(ChatRequest(messages=[Message(role="user", content=prompt)], tier="fast", temperature=0.0, json_schema=schema, json_schema_name="skill_args", purpose="skill.args"))
            return free_args(resp.json_data or {})
        except Exception:  # noqa: BLE001
            return {}

    def _prompt(self, goal: str, obs: Observation, api_doc: str, examples: str, feedback: str, hint: str) -> str:
        parts = [
            f"# Goal\n{goal}",
            f"# Situation\n{render_sensory(obs)}\n{render_inventory(obs)}\n{render_blocks(obs)}",
            f"# Skill API\n{api_doc[:14000]}",
            SKILL_RULES,
        ]
        if hint:
            parts.append(f"# Hints\n{hint}")
        if examples:
            parts.append(f"# Similar skills from my library (reuse patterns, do not copy blindly)\n{examples}")
        if feedback:
            parts.append(f"# Feedback on the previous attempt\n{feedback}")
        return "\n\n".join(parts)
