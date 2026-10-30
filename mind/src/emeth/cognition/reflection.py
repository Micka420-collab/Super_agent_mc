"""Reflection — noticing that I am going in circles.

A language model given the same context twice tends to answer the same thing twice, and a body that failed the
same way twice will fail a third time. Most agents loop until a budget runs out. This module is the small
metacognitive layer that watches the stream of attempts (primitive calls, skills, constructions) and the stream of
decisions (valid or rejected), and when it sees a pattern it writes a `[REFLECTION]` block into the next thought:
*what* repeated, *why* it fails (the error code), and *which* concrete alternatives exist. It also tells the loop
to cool the model down (lower temperature) after rejected decisions. No LLM involved; everything is unit-testable.
"""

from __future__ import annotations

import json
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from emeth.cognition.planner import Task

# what a real player would try next, per failure code
ALTERNATIVES: dict[str, str] = {
    "NOT_FOUND": "what I am looking for is not around here: `explore` in a new direction, or for an ore `descend` to its depth (`ore_info` tells which) and `tunnel` there instead of looking at the surface",
    "MISSING_ITEM": "I lack an ingredient: obtain it first (`get {name}` plans the whole chain), or pick a cheaper alternative",
    "MISSING_TOOL": "I need a better tool first: `get` the pickaxe/axe the error names, then retry",
    "NO_PATH": "I cannot reach it from here: come closer another way, dig towards it, or choose a reachable target",
    "TIMEOUT": "it takes too long in one go: split it into smaller steps (fewer blocks, shorter distance, lower count)",
    "INTERRUPTED": "my body keeps interrupting me (reflexes): deal with the threat or the danger first, then resume",
    "BAD_REQUEST": "the arguments were wrong: reread the primitive signature in the body interface and pass only the listed keys",
    "SKILL_ERROR": "the program itself is broken: use primitives directly for the next step instead of another program",
    "SANDBOX_REJECTED": "the generated code was refused: use primitives directly",
    "BUSY": "my hands were busy: choose `keep` or `stop` first",
}


@dataclass
class Attempt:
    signature: str
    ok: bool
    code: str = ""
    detail: str = ""
    at: float = field(default_factory=time.time)


def signature_of(kind: str, name: str | None, args: dict[str, Any] | None = None, goal: str | None = None) -> str:
    """A stable key for 'the same attempt': primitive + literal args, or skill/design + goal."""
    if kind == "primitive":
        try:
            packed = json.dumps(args or {}, sort_keys=True, ensure_ascii=False)
        except (TypeError, ValueError):
            packed = str(args)
        return f"{name}({packed[:160]})"
    return f"{kind}: {(goal or name or '')[:160]}"


@dataclass
class Reflection:
    """Watches attempts and decisions; renders advice when a pattern of failure appears."""

    window: int = 12
    attempts: deque[Attempt] = field(default_factory=lambda: deque(maxlen=12))
    invalid_decisions: int = 0
    last_problems: list[str] = field(default_factory=list)
    # how many times the same reflection was shown without the behaviour changing
    nagged: int = 0
    _last_rendered: str = ""

    def __post_init__(self) -> None:
        self.attempts = deque(maxlen=self.window)

    # ---- inputs ----------------------------------------------------------------------------
    def record(self, signature: str, ok: bool, code: str = "", detail: str = "") -> None:
        self.attempts.append(Attempt(signature=signature, ok=ok, code=code or ("" if ok else "UNKNOWN"), detail=detail[:200]))

    def decision_rejected(self, problems: list[str]) -> None:
        self.invalid_decisions += 1
        self.last_problems = [p[:120] for p in problems][:3]

    def decision_accepted(self) -> None:
        self.invalid_decisions = 0
        self.last_problems = []

    # ---- analysis ---------------------------------------------------------------------------
    def same_failure_streak(self) -> tuple[str, str, int] | None:
        """(signature, code, n) when the last n ≥ 2 attempts are the same call failing the same way."""
        items = list(self.attempts)
        if len(items) < 2 or items[-1].ok:
            return None
        last = items[-1]
        n = 0
        for a in reversed(items):
            if a.ok or a.signature != last.signature or a.code != last.code:
                break
            n += 1
        return (last.signature, last.code, n) if n >= 2 else None

    def code_streak(self) -> tuple[str, int] | None:
        """(code, n) when the last n ≥ 3 attempts all failed with the same code, whatever the call."""
        items = list(self.attempts)
        if len(items) < 3 or items[-1].ok:
            return None
        code = items[-1].code
        n = 0
        for a in reversed(items):
            if a.ok or a.code != code:
                break
            n += 1
        return (code, n) if n >= 3 else None

    def failure_rate(self) -> float:
        items = list(self.attempts)
        return (sum(1 for a in items if not a.ok) / len(items)) if items else 0.0

    def temperature(self, base: float) -> float:
        """Cool the model down after rejected decisions; it answers more literally."""
        if self.invalid_decisions >= 2:
            return min(base, 0.2)
        if self.invalid_decisions == 1:
            return min(base, 0.35)
        return base

    def stuck(self) -> bool:
        s = self.same_failure_streak()
        return bool(s and s[2] >= 3) or bool(self.code_streak() and self.code_streak()[1] >= 4) or self.invalid_decisions >= 3  # type: ignore[index]

    # ---- output ----------------------------------------------------------------------------
    def render(self, task: Task | None = None) -> str:
        lines: list[str] = []
        streak = self.same_failure_streak()
        if streak:
            sig, code, n = streak
            lines.append(f"I have tried `{sig}` {n} times in a row and it failed with {code} each time. Repeating it will not change the outcome.")
            if code in ALTERNATIVES:
                lines.append(f"Alternative: {ALTERNATIVES[code]}.")
        else:
            cs = self.code_streak()
            if cs:
                code, n = cs
                lines.append(f"My last {n} attempts all failed with {code}, through different actions.")
                if code in ALTERNATIVES:
                    lines.append(f"Alternative: {ALTERNATIVES[code]}.")
        if self.invalid_decisions >= 2:
            why = "; ".join(self.last_problems) or "invalid JSON"
            lines.append(f"My last {self.invalid_decisions} thoughts were rejected before reaching my body ({why}). Answer with one plain primitive from the body interface and literal arguments, or `wait`.")
        if task is not None and task.attempts >= 2:
            lines.append(f"The task \"{task.description}\" is on attempt {task.attempts + 1} of {task.max_attempts}" + (f"; last error: {task.last_error[:120]}" if task.last_error else "") + ".")
        if not lines:
            self.nagged = 0
            self._last_rendered = ""
            return ""
        rendered = "\n".join(lines)
        self.nagged = self.nagged + 1 if rendered == self._last_rendered else 0
        self._last_rendered = rendered
        if self.nagged >= 1:
            lines.append("I already noticed this and did not change course. Now I must do something different: another method, another target, ask a player for help, or abandon this goal with a reason (goal_update: abandon).")
        return "\n".join(lines)

    def snapshot(self) -> dict[str, Any]:
        return {
            "attempts": len(self.attempts),
            "failure_rate": round(self.failure_rate(), 2),
            "same_failure": self.same_failure_streak(),
            "code_streak": self.code_streak(),
            "invalid_decisions": self.invalid_decisions,
            "stuck": self.stuck(),
        }
