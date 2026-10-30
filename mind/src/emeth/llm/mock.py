"""Scripted provider for tests and offline dry-runs."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from emeth.config import ProviderConfig
from emeth.llm.base import Provider, extract_json
from emeth.llm.types import ChatRequest, ChatResponse, LLMError, Usage

Script = Callable[[ChatRequest], str | dict[str, Any] | Exception]


class MockProvider(Provider):
    """Answers from a queue of canned responses or a scripting function. Records every request."""

    def __init__(self, provider_id: str = "mock", responses: list[str | dict[str, Any] | Exception] | None = None, script: Script | None = None):
        super().__init__(ProviderConfig(id=provider_id, base_url="mock://", models={"smart": "mock-1", "fast": "mock-1", "code": "mock-1", "vision": "mock-1"}, supports_embeddings=True, embedding_model="mock-embed"))
        self.responses = list(responses or [])
        self.script = script
        self.requests: list[ChatRequest] = []
        self.fail_embeddings = False

    def available(self) -> bool:
        return True

    async def chat(self, request: ChatRequest) -> ChatResponse:
        self.requests.append(request)
        if self.script:
            answer = self.script(request)
        elif self.responses:
            answer = self.responses.pop(0)
        else:
            answer = {"reason": "idle", "speech": None, "action": {"type": "none"}} if request.json_schema else "ok"
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, dict):
            text = json.dumps(answer, ensure_ascii=False)
            return ChatResponse(text=text, json_data=answer, provider=self.id, model="mock-1", usage=Usage(input_tokens=10, output_tokens=5))
        return ChatResponse(text=answer, json_data=extract_json(answer) if request.json_schema else None, provider=self.id, model="mock-1", usage=Usage(input_tokens=10, output_tokens=5))

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if self.fail_embeddings:
            raise LLMError("mock embeddings down", status=503, retryable=True, provider=self.id)
        from emeth.llm.embeddings import hashed_embedding

        return [hashed_embedding(t) for t in texts]
