"""LLM router — capability tiers, ordered failover, circuit breakers, budget, decision log.

Semantics follow cc-switch / ai-memory: one attempt per provider, transient errors move to the next
provider in the queue, deterministic errors (400/401/403/404/422/schema) stop immediately, breakers
open after repeated failures and half-open after a cooldown.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from emeth.config import ProviderConfig
from emeth.llm.base import Provider
from emeth.llm.types import ChatRequest, ChatResponse, LLMError

log = logging.getLogger(__name__)


@dataclass
class BreakerConfig:
    failure_threshold: int = 4
    success_threshold: int = 2
    timeout_s: float = 60.0
    error_rate_threshold: float = 0.6
    min_requests: int = 10


@dataclass
class Breaker:
    config: BreakerConfig = field(default_factory=BreakerConfig)
    state: str = "closed"  # closed | open | half_open
    consecutive_failures: int = 0
    half_open_successes: int = 0
    opened_at: float = 0.0
    history: deque[bool] = field(default_factory=lambda: deque(maxlen=50))
    last_error: str = ""

    def allow(self, now: float | None = None) -> bool:
        now = now or time.monotonic()
        if self.state == "closed":
            return True
        if self.state == "open":
            if now - self.opened_at >= self.config.timeout_s:
                self.state = "half_open"
                self.half_open_successes = 0
                return True
            return False
        return True  # half-open: allow probes

    def record(self, ok: bool, error: str = "", now: float | None = None) -> None:
        now = now or time.monotonic()
        self.history.append(ok)
        if ok:
            self.consecutive_failures = 0
            if self.state == "half_open":
                self.half_open_successes += 1
                if self.half_open_successes >= self.config.success_threshold:
                    self.state = "closed"
            return
        self.last_error = error
        self.consecutive_failures += 1
        if self.state == "half_open":
            self._open(now)
            return
        rate = (self.history.count(False) / len(self.history)) if len(self.history) >= self.config.min_requests else 0.0
        if self.consecutive_failures >= self.config.failure_threshold or rate >= self.config.error_rate_threshold:
            self._open(now)

    def _open(self, now: float) -> None:
        self.state = "open"
        self.opened_at = now


@dataclass
class Ledger:
    """Per-provider token/cost/latency accounting."""

    calls: int = 0
    failures: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms_total: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "failures": self.failures,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": round(self.cost_usd, 6),
            "avg_latency_ms": round(self.latency_ms_total / self.calls, 1) if self.calls else 0.0,
        }


class RateLimiter:
    """Sliding-window requests-per-minute budget shared by the whole mind."""

    def __init__(self, max_per_minute: int):
        self.max = max_per_minute
        self.times: deque[float] = deque()

    async def acquire(self) -> None:
        while True:
            now = time.monotonic()
            while self.times and now - self.times[0] > 60:
                self.times.popleft()
            if len(self.times) < self.max:
                self.times.append(now)
                return
            await asyncio.sleep(max(0.05, 60 - (now - self.times[0])))


class LLMRouter:
    def __init__(
        self,
        providers: list[Provider],
        tier_preferences: dict[str, list[str]] | None = None,
        max_requests_per_minute: int = 20,
        log_path: Path | None = None,
        breaker_config: BreakerConfig | None = None,
        max_attempts: int = 3,
        max_usd: float = 0.0,
        spend_path: Path | None = None,
    ):
        self.providers: dict[str, Provider] = {p.id: p for p in providers}
        self.order = [p.id for p in providers]
        self.tier_preferences = tier_preferences or {}
        self.breakers: dict[str, Breaker] = {p.id: Breaker(breaker_config or BreakerConfig()) for p in providers}
        self.ledger: dict[str, Ledger] = {p.id: Ledger() for p in providers}
        self.limiter = RateLimiter(max_requests_per_minute)
        self.log_path = log_path
        self.max_attempts = max_attempts
        self.last_provider: str | None = None
        # hard spend cap on paid providers (those with an api_key_env); 0 = unlimited. The total survives restarts
        # through spend_path, so a crash loop cannot re-spend the budget. Local providers stay usable past the cap.
        self.max_usd = max_usd
        self.spend_path = spend_path
        self.spent_usd = self._load_spend()

    @classmethod
    def from_configs(cls, configs: list[ProviderConfig], **kwargs: Any) -> LLMRouter:
        from emeth.llm.anthropic import AnthropicProvider
        from emeth.llm.openai_compat import OpenAICompatProvider

        providers: list[Provider] = []
        for c in configs:
            providers.append(AnthropicProvider(c) if c.api_format == "anthropic" else OpenAICompatProvider(c))
        return cls(providers, **kwargs)

    # ---------------------------------------------------------------------------------------
    def candidates(self, tier: str, *, need_vision: bool = False, need_embeddings: bool = False) -> list[Provider]:
        preferred = self.tier_preferences.get(tier, [])
        ordered = [pid for pid in preferred if pid in self.providers] + [pid for pid in self.order if pid not in preferred]
        out: list[Provider] = []
        for pid in ordered:
            p = self.providers[pid]
            if not p.available():
                continue
            if need_vision and not p.config.supports_vision:
                continue
            if need_embeddings and not p.config.supports_embeddings:
                continue
            if not need_embeddings and not p.model_for(tier):
                continue
            if not p.config.in_failover_queue and out:
                continue
            out.append(p)
        return out

    def budget_exhausted(self) -> bool:
        return self.max_usd > 0 and self.spent_usd >= self.max_usd

    def _paid(self, provider: Provider) -> bool:
        return provider.config.api_key_env is not None

    def _load_spend(self) -> float:
        if not self.spend_path or not self.spend_path.exists():
            return 0.0
        try:
            return float(json.loads(self.spend_path.read_text(encoding="utf-8")).get("spent_usd", 0.0))
        except (OSError, ValueError, AttributeError) as exc:
            # unreadable ledger: refuse to guess low — treat the budget as spent until a human looks at it
            log.warning("spend ledger unreadable (%s); paid providers disabled", exc)
            return float("inf") if self.max_usd > 0 else 0.0

    def _save_spend(self) -> None:
        if not self.spend_path:
            return
        try:
            self.spend_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.spend_path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"spent_usd": round(self.spent_usd, 6), "max_usd": self.max_usd, "updated": time.time()}), encoding="utf-8")
            tmp.replace(self.spend_path)
        except OSError as exc:  # pragma: no cover
            log.warning("spend ledger write failed: %s", exc)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        need_vision = any(m.images for m in request.messages)
        cands = [p for p in self.candidates(request.tier, need_vision=need_vision) if self.breakers[p.id].allow()]
        if self.budget_exhausted():
            cands = [p for p in cands if not self._paid(p)]
            if not cands:
                raise LLMError(f"spend cap reached ({self.spent_usd:.4f} / {self.max_usd:.2f} USD); no local provider", retryable=False)
        if not cands:
            raise LLMError(f"no available provider for tier '{request.tier}' (all missing keys or circuit-open)", retryable=False)
        errors: list[str] = []
        for provider in cands[: self.max_attempts]:
            await self.limiter.acquire()
            t0 = time.perf_counter()
            try:
                resp = await provider.chat(request)
            except LLMError as exc:
                self._record(provider.id, False, str(exc), (time.perf_counter() - t0) * 1000, request, None)
                errors.append(str(exc))
                if not exc.retryable:
                    raise
                continue
            except Exception as exc:  # noqa: BLE001 — network / parsing failures are transient
                self._record(provider.id, False, str(exc), (time.perf_counter() - t0) * 1000, request, None)
                errors.append(f"{provider.id}: {exc}")
                continue
            self._record(provider.id, True, "", resp.latency_ms, request, resp)
            self.last_provider = provider.id
            return resp
        raise LLMError("all providers failed: " + " | ".join(errors), retryable=False)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        cands = [p for p in self.candidates("embed", need_embeddings=True) if self.breakers[p.id].allow()]
        errors: list[str] = []
        for provider in cands[: self.max_attempts]:
            try:
                vectors = await provider.embed(texts)
                self.breakers[provider.id].record(True)
                return vectors
            except LLMError as exc:
                self.breakers[provider.id].record(False, str(exc))
                errors.append(str(exc))
                if not exc.retryable:
                    break
        raise LLMError("embeddings unavailable: " + " | ".join(errors), retryable=False)

    def _record(self, pid: str, ok: bool, error: str, latency_ms: float, request: ChatRequest, resp: ChatResponse | None) -> None:
        self.breakers[pid].record(ok, error)
        led = self.ledger[pid]
        led.calls += 1
        led.latency_ms_total += latency_ms
        if not ok:
            led.failures += 1
        if resp:
            led.input_tokens += resp.usage.input_tokens
            led.output_tokens += resp.usage.output_tokens
            led.cost_usd += resp.cost_usd
            if resp.cost_usd and self._paid(self.providers[pid]):
                self.spent_usd += resp.cost_usd
                self._save_spend()
        if self.log_path:
            entry = {
                "ts": time.time(),
                "provider": pid,
                "model": resp.model if resp else None,
                "tier": request.tier,
                "purpose": request.purpose,
                "ok": ok,
                "error": error[:300] if error else None,
                "latency_ms": round(latency_ms, 1),
                "input_tokens": resp.usage.input_tokens if resp else None,
                "output_tokens": resp.usage.output_tokens if resp else None,
                "cached_tokens": resp.usage.cached_tokens if resp else None,
                "cost_usd": round(resp.cost_usd, 6) if resp else None,
                "prompt_chars": sum(len(m.content) for m in request.messages),
            }
            try:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                with self.log_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except OSError as exc:  # pragma: no cover
                log.debug("decision log write failed: %s", exc)

    def budget(self) -> dict[str, Any]:
        return {"spent_usd": round(self.spent_usd, 6), "max_usd": self.max_usd, "exhausted": self.budget_exhausted()}

    def health(self) -> dict[str, Any]:
        return {
            pid: {
                "available": p.available(),
                "breaker": self.breakers[pid].state,
                "consecutive_failures": self.breakers[pid].consecutive_failures,
                "last_error": self.breakers[pid].last_error[:120],
                **self.ledger[pid].as_dict(),
            }
            for pid, p in self.providers.items()
        }

    async def aclose(self) -> None:
        for p in self.providers.values():
            await p.aclose()
