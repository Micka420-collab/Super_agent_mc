"""OpenAI-compatible chat completions adapter — OpenAI, OpenRouter, Ollama, LM Studio, vLLM, DeepSeek..."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import httpx

from emeth.config import ProviderConfig
from emeth.llm.anthropic import prompt_json_fallback
from emeth.llm.base import Provider, extract_json
from emeth.llm.types import ChatRequest, ChatResponse, LLMError, Message, ToolCall, Usage, classify_status


def to_openai(messages: list[Message]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.role == "tool":
            out.append({"role": "tool", "tool_call_id": m.tool_call_id or "", "content": m.content})
            continue
        item: dict[str, Any] = {"role": m.role}
        if m.images and m.role == "user":
            parts: list[dict[str, Any]] = [{"type": "text", "text": m.content}] if m.content else []
            for img in m.images:
                parts.append({"type": "image_url", "image_url": {"url": f"data:{img.media_type};base64,{img.data_base64}"}})
            item["content"] = parts
        else:
            item["content"] = m.content
        if m.tool_calls:
            item["tool_calls"] = [
                {"id": tc.id, "type": "function", "function": {"name": tc.name, "arguments": json.dumps(tc.arguments, ensure_ascii=False)}}
                for tc in m.tool_calls
            ]
        out.append(item)
    return out


class OpenAICompatProvider(Provider):
    def __init__(self, config: ProviderConfig, client: httpx.AsyncClient | None = None):
        super().__init__(config)
        self._client = client or httpx.AsyncClient(timeout=config.timeout_s)
        # learned quirks (VoxelMind pattern): drop features the endpoint rejects
        self._json_schema_ok = config.supports_json_schema
        self._tools_ok = config.supports_tools

    async def aclose(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json", **self.config.headers}
        key = self.api_key()
        if key:
            h["authorization"] = f"Bearer {key}"
        return h

    async def chat(self, request: ChatRequest) -> ChatResponse:
        model = self.model_for(request.tier)
        if not model:
            raise LLMError(f"{self.id}: no model for tier {request.tier}", retryable=False, provider=self.id)
        use_schema = bool(request.json_schema) and self._json_schema_ok
        messages = request.messages if use_schema or not request.json_schema else prompt_json_fallback(request)
        body: dict[str, Any] = {
            "model": model,
            "messages": to_openai(messages),
            "temperature": request.temperature,
            "max_tokens": request.max_tokens or self.config.max_output_tokens,
        }
        if request.stop:
            body["stop"] = request.stop
        if "openrouter.ai" in self.config.base_url:
            body["usage"] = {"include": True}  # OpenRouter then reports the billed cost of the call
        if request.tools and self._tools_ok:
            body["tools"] = [{"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}} for t in request.tools]
            body["tool_choice"] = "required" if request.tool_choice == "required" else request.tool_choice
        if use_schema:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": request.json_schema_name, "schema": request.json_schema, "strict": False},
            }
        elif request.json_schema:
            body["response_format"] = {"type": "json_object"}

        t0 = time.perf_counter()
        try:
            resp = await self._client.post(f"{self.config.base_url.rstrip('/')}/chat/completions", json=body, headers=self._headers())
        except httpx.HTTPError as exc:
            raise LLMError(f"{self.id}: {exc}", retryable=True, provider=self.id) from exc
        latency = (time.perf_counter() - t0) * 1000
        if resp.status_code == 400 and (use_schema or body.get("response_format")):
            # endpoint rejects structured output → learn the quirk and retry once with prompt-only JSON
            self._json_schema_ok = False
            body.pop("response_format", None)
            body["messages"] = to_openai(prompt_json_fallback(request))
            resp = await self._client.post(f"{self.config.base_url.rstrip('/')}/chat/completions", json=body, headers=self._headers())
            latency = (time.perf_counter() - t0) * 1000
        if resp.status_code == 400 and "temperature" in body and "temperature" in resp.text.lower():
            body.pop("temperature", None)  # e.g. Claude 5.5 models behind OpenRouter: default sampling only
            resp = await self._client.post(f"{self.config.base_url.rstrip('/')}/chat/completions", json=body, headers=self._headers())
            latency = (time.perf_counter() - t0) * 1000
        if resp.status_code == 400 and "tools" in body:
            self._tools_ok = False
            body.pop("tools", None)
            body.pop("tool_choice", None)
            resp = await self._client.post(f"{self.config.base_url.rstrip('/')}/chat/completions", json=body, headers=self._headers())
            latency = (time.perf_counter() - t0) * 1000
        if resp.status_code >= 400:
            raise LLMError(f"{self.id}: HTTP {resp.status_code} {resp.text[:300]}", status=resp.status_code, retryable=classify_status(resp.status_code), provider=self.id)
        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        text = message.get("content") or ""
        if isinstance(text, list):  # some servers return content parts
            text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
        tool_calls: list[ToolCall] = []
        for tc in message.get("tool_calls") or []:
            fn = tc.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {"_raw": fn.get("arguments")}
            tool_calls.append(ToolCall(id=tc.get("id") or uuid.uuid4().hex, name=fn.get("name", ""), arguments=args if isinstance(args, dict) else {"value": args}))
        json_data = extract_json(text) if request.json_schema else None
        usage = data.get("usage") or {}
        details = usage.get("prompt_tokens_details") or {}
        u = Usage(
            input_tokens=usage.get("prompt_tokens", 0) or 0,
            output_tokens=usage.get("completion_tokens", 0) or 0,
            cached_tokens=details.get("cached_tokens", 0) or 0,
        )
        cost = (u.input_tokens * self.config.input_cost_per_m + u.output_tokens * self.config.output_cost_per_m) / 1_000_000
        billed = usage.get("cost")
        if isinstance(billed, (int, float)) and not isinstance(billed, bool) and billed >= 0:
            cost = max(cost, float(billed))  # the provider's own bill wins over a stale price table
        return ChatResponse(
            text=text,
            tool_calls=tool_calls,
            json_data=json_data,
            finish_reason=str(choice.get("finish_reason", "")),
            usage=u,
            provider=self.id,
            model=model,
            latency_ms=latency,
            cost_usd=cost,
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.config.supports_embeddings or not self.config.embedding_model:
            raise LLMError(f"{self.id}: embeddings not supported", retryable=False, provider=self.id)
        body = {"model": self.config.embedding_model, "input": texts}
        try:
            resp = await self._client.post(f"{self.config.base_url.rstrip('/')}/embeddings", json=body, headers=self._headers())
        except httpx.HTTPError as exc:
            raise LLMError(f"{self.id}: {exc}", retryable=True, provider=self.id) from exc
        if resp.status_code >= 400:
            raise LLMError(f"{self.id}: HTTP {resp.status_code} {resp.text[:200]}", status=resp.status_code, retryable=classify_status(resp.status_code), provider=self.id)
        data = resp.json()
        rows = sorted(data.get("data", []), key=lambda d: d.get("index", 0))
        return [list(map(float, r.get("embedding", []))) for r in rows]
