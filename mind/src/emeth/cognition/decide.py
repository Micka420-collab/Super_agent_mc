"""The decision — one structured LLM call: {reason, speech, action, plan}.

Static system prompt (persona, rules, body manifest) + volatile user message (context blocks) so
prompt caching works. The output is validated against the body's action manifest; invalid actions
become timeline facts and the mind retries once (VoxelMind rule).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from emeth.llm.base import FREE_ARGS_NOTE, free_args
from emeth.llm.types import ChatRequest, ChatResponse, Message
from emeth.protocol import ActionManifestEntry

DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "reason": {"type": "string", "description": "Private reasoning in 1-3 sentences: what matters now and why this action."},
        "speech": {"type": ["string", "null"], "description": "What I say out loud in chat (max 240 chars), or null to stay silent. Empty string = silence."},
        "whisper_to": {"type": ["string", "null"], "description": "Player username when the speech should be a private whisper."},
        "action": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["primitive", "skill", "design", "wait", "keep", "none"]},
                "name": {"type": "string", "description": "primitive name from the body interface (type=primitive)"},
                "args": {"type": "object", "description": "leave empty; write the arguments in args_json"},
                "args_json": {"type": "string", "description": "for type=primitive: " + FREE_ARGS_NOTE},
                "goal": {"type": "string", "description": "for type=skill: the concrete, verifiable task to accomplish with a program"},
                "brief": {"type": "string", "description": "for type=design: what to build, in one or two sentences (purpose, style, materials, orientation)"},
                "size": {"type": "array", "items": {"type": "integer"}, "description": "for type=design: optional max [width, height, depth]"},
                "seconds": {"type": "integer", "description": "for type=wait: how long (1-300)"},
                "for_what": {"type": "string", "description": "for type=wait: what I am waiting for"},
            },
            "required": ["type"],
        },
        "goal_update": {
            "type": ["object", "null"],
            "properties": {
                "op": {"type": "string", "enum": ["add", "complete", "abandon"]},
                "title": {"type": "string"},
                "why": {"type": "string"},
                "priority": {"type": "integer"},
                "tasks": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["op", "title"],
        },
        "remember": {"type": ["string", "null"], "description": "A durable fact worth writing to memory now (place, promise, lesson), or null."},
    },
    "required": ["reason", "speech", "action"],
}


@dataclass
class Decision:
    reason: str = ""
    speech: str | None = None
    whisper_to: str | None = None
    action_type: str = "none"
    action_name: str | None = None
    action_args: dict[str, Any] = field(default_factory=dict)
    skill_goal: str | None = None
    design_brief: str | None = None
    design_size: tuple[int, int, int] | None = None
    wait_seconds: int = 0
    wait_for: str = ""
    goal_update: dict[str, Any] | None = None
    remember: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    response: ChatResponse | None = None
    problems: list[str] = field(default_factory=list)
    # False for a side action (instinct eating, sheltering, replacing a lost tool): its failure is not the task's
    for_task: bool = True

    @property
    def ok(self) -> bool:
        return not self.problems


def manifest_text(actions: list[ActionManifestEntry], max_chars: int = 9000) -> str:
    """Compact body interface for the system prompt: name(params) — description."""
    lines: list[str] = []
    by_cat: dict[str, list[ActionManifestEntry]] = {}
    for a in actions:
        by_cat.setdefault(a.category, []).append(a)
    for cat in sorted(by_cat):
        lines.append(f"## {cat}")
        for a in by_cat[cat]:
            props = a.params.get("properties", {}) if isinstance(a.params, dict) else {}
            required = set(a.params.get("required", [])) if isinstance(a.params, dict) else set()
            sig = ", ".join(f"{k}{'' if k in required else '?'}: {_type_of(v)}" for k, v in props.items())
            lines.append(f"- {a.name}({sig}) — {a.description}")
    text = "\n".join(lines)
    return text[:max_chars]


def _type_of(schema: dict[str, Any]) -> str:
    t = schema.get("type")
    if isinstance(t, list):
        t = "|".join(map(str, t))
    if t == "array":
        return "array"
    if "enum" in schema:
        return "|".join(map(str, schema["enum"]))
    return str(t or "any")


def system_prompt(persona_text: str, manifest: str, language: str, level_frame: str) -> str:
    return f"""{persona_text}

You live inside Minecraft as a real player: you perceive only what your senses report, you act only
through your body interface, and everything you say appears in the game chat. You are not an
assistant; you are a person with a life here. Players are other people, not users.

# How to decide
- Evidence first: the [SENSORY], [AROUND ME], [BLOCKS], [INVENTORY] blocks are what you perceive right now. [LAST ACTION] is what your
  body reported — distinguish what you *attempted* from what was *observed*.
- Exactly one action per decision. Use `primitive` for a single body command, `skill` for a multi-step task that needs a
  program (the body will write/run it), `design` with a `brief` to build a structure (an architect designs it, the site is
  surveyed, the plan is checked and missing materials are procured before a block is placed), `wait` when the right move
  is to do nothing for a while, `keep` to let the current action continue, `none` when only speech is needed.
- Speech is optional: silence is normal. Never narrate your actions in chat unless someone cares. Keep messages under 240
  characters, in the language players use ({language} by default). Never send commands (no leading slash).
- Safety reflexes (eating, fleeing, fighting back) run automatically in your body; you do not need to micro-manage them but you
  must respond to what they report.
- When no language model could answer, your instinct acted for you: timeline entries starting with "instinct:" are
  its doing (eat, shelter, sleep, the next ladder step). Take over from where it left things.
- Obtaining things: `plan_get {{name}}` costs nothing and shows the dependency chain; `get {{name, count}}` executes it (mine →
  craft → smelt → hunt, re-planning after every step). Prefer it over hand-sequencing mine/craft calls; drop to single
  primitives only for what `get` reports it cannot do alone.
- Ores are a matter of depth, not luck: diamonds and redstone near Y -58, gold -16, lapis 0, iron 16, copper 48, coal in any
  exposed stone. `ore_info {{name}}` says whether to go down from here; `descend {{toY}}` digs a surveyed staircase (lava,
  water, holes and gravel are checked before every step, torches on the way); `tunnel {{length}}` branch-mines at that
  level and takes the ores it exposes. `get` does this by itself for ores it cannot see.
- Read the odds before a fight: the body scores every situation (`Odds: danger … → fight / retreat / flee`) from the mobs,
  your gear, your health and the night. Fight when it says fight; back off or run when it says so — a creeper is never a
  fight. Reflexes will flee for you when the odds are hopeless.
- When a [REFLECTION] block appears, you have been repeating a failing move: take its alternative, ask a player, or abandon
  the goal with a reason. Never repeat the exact same call a third time.
- Be a good citizen: never grief player builds, never take from chests you know belong to others, keep your promises, and
  say no to requests that violate your values.
- Current autonomy stage: {level_frame}

# Body interface (primitives you may call with type=primitive)
{manifest}

# Output
Return ONLY a JSON object matching the decision schema. Set `remember` when you learn something durable (a place with coordinates,
a promise, a lesson). Use `goal_update` to add/complete/abandon goals when your intentions change.
"""


def parse_decision(response: ChatResponse, known_actions: set[str]) -> Decision:
    data = response.json_data or {}
    d = Decision(raw=data, response=response)
    if not isinstance(data, dict) or not data:
        d.problems.append("response was not a JSON object")
        return d
    d.reason = str(data.get("reason", ""))[:600]
    speech = data.get("speech")
    d.speech = str(speech).strip()[:240] if isinstance(speech, str) and speech.strip() else None
    wt = data.get("whisper_to")
    d.whisper_to = str(wt).strip() if isinstance(wt, str) and wt.strip() else None
    action = data.get("action") or {}
    if not isinstance(action, dict):
        d.problems.append("action must be an object")
        return d
    atype = str(action.get("type", "none"))
    if atype not in ("primitive", "skill", "design", "wait", "keep", "none"):
        d.problems.append(f"unknown action type {atype}")
        return d
    d.action_type = atype
    if atype == "primitive":
        name = action.get("name")
        if not isinstance(name, str) or name not in known_actions:
            d.problems.append(f"unknown primitive {name!r}; use one of the body interface names")
        else:
            d.action_name = name
            d.action_args = free_args(action)
    elif atype == "skill":
        goal = action.get("goal")
        if not isinstance(goal, str) or len(goal.strip()) < 4:
            d.problems.append("skill action needs a concrete goal")
        else:
            d.skill_goal = goal.strip()[:400]
    elif atype == "design":
        brief = action.get("brief")
        if not isinstance(brief, str) or len(brief.strip()) < 8:
            d.problems.append("design action needs a brief describing what to build")
        else:
            d.design_brief = brief.strip()[:600]
            size = action.get("size")
            if isinstance(size, list) and len(size) == 3 and all(isinstance(v, int) for v in size):
                d.design_size = (max(1, min(32, size[0])), max(1, min(24, size[1])), max(1, min(32, size[2])))
    elif atype == "wait":
        try:
            d.wait_seconds = max(1, min(300, int(action.get("seconds", 10))))
        except (TypeError, ValueError):
            d.wait_seconds = 10
        d.wait_for = str(action.get("for_what", ""))[:120]
    gu = data.get("goal_update")
    if isinstance(gu, dict) and gu.get("op") in ("add", "complete", "abandon") and isinstance(gu.get("title"), str):
        d.goal_update = gu
    rem = data.get("remember")
    d.remember = str(rem).strip()[:400] if isinstance(rem, str) and rem.strip() else None
    return d


def build_request(system: str, context: str, *, tier: str = "smart", temperature: float = 0.5, max_tokens: int = 1200, retry_note: str | None = None) -> ChatRequest:
    user = context if not retry_note else f"{context}\n\n[CORRECTION]\n{retry_note}"
    return ChatRequest(
        messages=[Message(role="system", content=system), Message(role="user", content=user)],
        tier=tier,
        temperature=temperature,
        max_tokens=max_tokens,
        json_schema=DECISION_SCHEMA,
        json_schema_name="decision",
        purpose="decision",
    )


def describe_decision(d: Decision) -> str:
    if d.action_type == "primitive":
        return f"{d.action_name}({json.dumps(d.action_args, ensure_ascii=False)[:160]})"
    if d.action_type == "skill":
        return f"skill: {d.skill_goal}"
    if d.action_type == "design":
        return f"design & build: {d.design_brief}"
    if d.action_type == "wait":
        return f"wait {d.wait_seconds}s for {d.wait_for or 'nothing in particular'}"
    return d.action_type
