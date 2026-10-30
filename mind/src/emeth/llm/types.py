"""Canonical LLM types — one internal format, adapters per provider (cc-switch lesson)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Role = Literal["system", "user", "assistant", "tool"]


class ImagePart(BaseModel):
    """A base64 image attached to a user message (retina frames, screenshots)."""

    media_type: str = "image/png"
    data_base64: str


class Message(BaseModel):
    role: Role
    content: str = ""
    images: list[ImagePart] = Field(default_factory=list)
    # assistant tool calls / tool results
    tool_calls: list[ToolCall] = Field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None


class ToolSpec(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any]  # JSON schema


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any]


class ChatRequest(BaseModel):
    messages: list[Message]
    tier: str = "smart"
    temperature: float = 0.4
    max_tokens: int | None = None
    tools: list[ToolSpec] = Field(default_factory=list)
    tool_choice: Literal["auto", "required", "none"] = "auto"
    # When set, ask for a JSON object following this schema (falls back to prompt-only JSON mode).
    json_schema: dict[str, Any] | None = None
    json_schema_name: str = "response"
    stop: list[str] = Field(default_factory=list)
    # free-form label for the decision log
    purpose: str = ""


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0


class ChatResponse(BaseModel):
    text: str = ""
    tool_calls: list[ToolCall] = Field(default_factory=list)
    json_data: dict[str, Any] | None = None
    finish_reason: str = ""
    usage: Usage = Field(default_factory=Usage)
    provider: str = ""
    model: str = ""
    latency_ms: float = 0.0
    cost_usd: float = 0.0


class LLMError(Exception):
    def __init__(self, message: str, *, status: int | None = None, retryable: bool = True, provider: str = ""):
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.provider = provider


def classify_status(status: int) -> bool:
    """True when the error is transient and worth another provider (cc-switch / ai-memory rule)."""
    if status in (408, 409, 425, 429):
        return True
    if status >= 500:
        return True
    return False
