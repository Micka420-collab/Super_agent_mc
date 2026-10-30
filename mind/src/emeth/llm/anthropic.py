"""Anthropic Messages API adapter (httpx, no SDK)."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import httpx

from emeth.config import ProviderConfig
from emeth.llm.base import Provider, extract_json, json_instruction
from emeth.llm.types import ChatRequest, ChatResponse, LLMError, Message, ToolCall, Usage, classify_status

ANTHROPIC_VERSION = "2023-06-01"


def _content_blocks(msg: Message) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for img in msg.images:
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": img.media_type, "data": img.data_base64}})
    if msg.content:
        blocks.append({"type": "text", "text": msg.content})
    return blocks


def to_anthropic(messages: list[Message]) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.role == "system":
            system_parts.append(m.content)
        elif m.role == "user":
            out.append({"role": "user", "content": _content_blocks(m) or [{"type": "text", "text": ""}]})
        elif m.role == "assistant":
            blocks: list[dict[str, Any]] = []
            if m.content:
                blocks.append({"type": "text", "text": m.content})
            for tc in m.tool_calls:
                blocks.append({"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments})
            out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": ""}]})
        elif m.role == "tool":
            out.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": m.tool_call_id or "", "content": m.content}]})
    # Anthropic requires alternating roles; merge consecutive same-role turns
    merged: list[dict[str, Any]] = []
    for item in out:
        if merged and merged[-1]["role"] == item["role"]:
            merged[-1]["content"] = merged[-1]["content"] + item["content"]
        else:
            merged.append(item)
    return "\n\n".join(system_parts), merged


class AnthropicProvider(Provider):
    def __init__(self, config: ProviderConfig, client: httpx.AsyncClient | None = None):
        super().__init__(config)
        self._client = client or httpx.AsyncClient(timeout=config.timeout_s)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def chat(self, request: ChatRequest) -> ChatResponse:
        model = self.model_for(request.tier)
        if not model:
            raise LLMError(f"{self.id}: no model for tier {request.tier}", retryable=False, provider=self.id)
        messages = list(request.messages)
        if request.json_schema and not request.tools:
            # Anthropic has no response_format: use a forced tool call carrying the schema (most reliable).
            tools = [{"name": request.json_schema_name, "description": "Return the structured answer.", "input_schema": request.json_schema}]
            tool_choice: dict[str, Any] | None = {"type": "tool", "name": request.json_schema_name}
        else:
            tools = [{"name": t.name, "description": t.description, "input_schema": t.parameters} for t in request.tools]
            tool_choice = None
            if request.tools:
                tool_choice = {"type": "any"} if request.tool_choice == "required" else {"type": "auto"}
                if request.tool_choice == "none":
                    tools = []
                    tool_choice = None
        system, conv = to_anthropic(messages)
        body: dict[str, Any] = {
            "model": model,
            "max_tokens": request.max_tokens or self.config.max_output_tokens,
            "messages": conv,
            "temperature": request.temperature,
        }
        if system:
            body["system"] = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
        if tools:
            body["tools"] = tools
        if tool_choice:
            body["tool_choice"] = tool_choice
        if request.stop:
            body["stop_sequences"] = request.stop
        headers = {
            "x-api-key": self.api_key() or "",
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            **self.config.headers,
        }
        t0 = time.perf_counter()
        try:
            resp = await self._client.post(f"{self.config.base_url.rstrip('/')}/v1/messages", json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise LLMError(f"{self.id}: {exc}", retryable=True, provider=self.id) from exc
        latency = (time.perf_counter() - t0) * 1000
        if resp.status_code >= 400:
            raise LLMError(f"{self.id}: HTTP {resp.status_code} {resp.text[:300]}", status=resp.status_code, retryable=classify_status(resp.status_code), provider=self.id)
        data = resp.json()
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        json_data = None
        for block in data.get("content", []):
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                if request.json_schema and block.get("name") == request.json_schema_name and not request.tools:
                    json_data = block.get("input")
                else:
                    tool_calls.append(ToolCall(id=block.get("id") or uuid.uuid4().hex, name=block.get("name", ""), arguments=block.get("input") or {}))
        text = "".join(text_parts)
        if request.json_schema and json_data is None:
            json_data = extract_json(text)
        usage = data.get("usage", {})
        u = Usage(
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cached_tokens=usage.get("cache_read_input_tokens", 0) or 0,
        )
        cost = (u.input_tokens * self.config.input_cost_per_m + u.output_tokens * self.config.output_cost_per_m) / 1_000_000
        return ChatResponse(
            text=text,
            tool_calls=tool_calls,
            json_data=json_data,
            finish_reason=str(data.get("stop_reason", "")),
            usage=u,
            provider=self.id,
            model=model,
            latency_ms=latency,
            cost_usd=cost,
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise LLMError(f"{self.id}: embeddings not supported", retryable=False, provider=self.id)


def prompt_json_fallback(request: ChatRequest) -> list[Message]:
    """Append the JSON instruction to the last user message (for providers without schema support)."""
    if not request.json_schema:
        return request.messages
    msgs = [m.model_copy(deep=True) for m in request.messages]
    instr = json_instruction(request.json_schema, request.json_schema_name)
    for m in reversed(msgs):
        if m.role == "user":
            m.content = f"{m.content}\n\n{instr}"
            return msgs
    msgs.append(Message(role="user", content=instr))
    return msgs


__all__ = ["AnthropicProvider", "to_anthropic", "prompt_json_fallback", "json"]
