"""Provider interface + shared helpers (JSON extraction, key resolution)."""

from __future__ import annotations

import json
import os
import re
from typing import Any

from emeth.config import ProviderConfig
from emeth.llm.types import ChatRequest, ChatResponse


class Provider:
    def __init__(self, config: ProviderConfig):
        self.config = config

    @property
    def id(self) -> str:
        return self.config.id

    def model_for(self, tier: str) -> str | None:
        return self.config.models.get(tier) or self.config.models.get("smart")

    def api_key(self) -> str | None:
        if self.config.api_key:
            return self.config.api_key
        if self.config.api_key_env:
            return os.environ.get(self.config.api_key_env)
        return None

    def available(self) -> bool:
        """A provider needs a key unless it is local (no api_key_env configured)."""
        if self.config.api_key_env is None:
            return True
        return bool(self.api_key())

    async def chat(self, request: ChatRequest) -> ChatResponse:  # pragma: no cover - interface
        raise NotImplementedError

    async def embed(self, texts: list[str]) -> list[list[float]]:  # pragma: no cover - interface
        raise NotImplementedError

    async def aclose(self) -> None:  # pragma: no cover - default no-op
        return None


_JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)


def extract_json(text: str) -> dict[str, Any] | None:
    """Best-effort JSON object extraction from model text (fenced, bare, or with chatter around)."""
    if not text:
        return None
    candidates: list[str] = []
    m = _JSON_FENCE.search(text)
    if m:
        candidates.append(m.group(1))
    stripped = text.strip()
    candidates.append(stripped)
    # first '{' .. last '}'
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end > start:
        candidates.append(stripped[start : end + 1])
    for c in candidates:
        try:
            data = json.loads(c)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    return None


def json_instruction(schema: dict[str, Any], name: str) -> str:
    return (
        f"Respond with ONLY a JSON object named `{name}` that validates against this JSON schema, no prose, no code fences:\n"
        + json.dumps(schema, ensure_ascii=False)
    )


FREE_ARGS_NOTE = 'arguments as a JSON object written as a string, e.g. "{\\"name\\": \\"oak_planks\\", \\"count\\": 4}"'


def free_args(data: dict[str, Any], key: str = "args") -> dict[str, Any]:
    """Read a free-form arguments object from structured output.

    Constrained decoding closes every object schema, so an object without declared properties can only come back
    as `{}` (observed live: `craft({})` four times in a row). Schemas therefore also offer `<key>_json`, a string;
    a non-empty object wins, then the string is parsed.
    """
    obj = data.get(key)
    if isinstance(obj, dict) and obj:
        return obj
    raw = data.get(f"{key}_json")
    if isinstance(raw, str) and raw.strip():
        parsed = extract_json(raw)
        if isinstance(parsed, dict):
            return parsed
    return obj if isinstance(obj, dict) else {}
