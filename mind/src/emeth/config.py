"""Mind configuration — environment variables (prefix EMETH_) and a YAML providers file."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProviderConfig(BaseModel):
    """One LLM endpoint. `models` maps capability tiers to concrete model names."""

    id: str
    api_format: Literal["anthropic", "openai_chat"] = "openai_chat"
    base_url: str
    api_key_env: str | None = None
    api_key: str | None = None
    models: dict[str, str] = Field(default_factory=dict)
    max_output_tokens: int = 4096
    headers: dict[str, str] = Field(default_factory=dict)
    timeout_s: float = 60.0
    supports_tools: bool = True
    supports_json_schema: bool = True
    supports_vision: bool = False
    supports_embeddings: bool = False
    embedding_model: str | None = None
    # cost per million tokens, optional (for the ledger)
    input_cost_per_m: float = 0.0
    output_cost_per_m: float = 0.0
    in_failover_queue: bool = True


class LoopConfig(BaseModel):
    """Timing of the cognitive loop (ms)."""

    debounce_chat_ms: int = 300
    debounce_hurt_ms: int = 150
    debounce_action_ms: int = 400
    quiet_moment_min_s: int = 45
    quiet_moment_max_s: int = 180
    idle_body_min_s: int = 20
    idle_body_max_s: int = 60
    max_requests_per_minute: int = 20
    max_decision_tokens: int = 1200
    memory_rewrite_every_events: int = 24
    max_skill_attempts: int = 4


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EMETH_", env_file=".env", extra="ignore")

    bridge_url: str = "ws://127.0.0.1:8765"
    bridge_token: str = ""
    data_dir: Path = Path("./data")
    persona_path: Path | None = None
    providers_path: Path | None = None
    skills_dir: Path = Path("../skills/library")
    language: str = "fr"
    log_level: str = "INFO"
    loop: LoopConfig = Field(default_factory=LoopConfig)
    # tiers → provider id preference order (first = preferred)
    tier_preferences: dict[str, list[str]] = Field(default_factory=dict)

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "wiki").mkdir(exist_ok=True)
        (self.data_dir / "logs").mkdir(exist_ok=True)
        self.skills_dir.mkdir(parents=True, exist_ok=True)


DEFAULT_PROVIDERS: list[ProviderConfig] = [
    ProviderConfig(
        id="anthropic",
        api_format="anthropic",
        base_url="https://api.anthropic.com",
        api_key_env="ANTHROPIC_API_KEY",
        models={"smart": "claude-sonnet-5-5", "fast": "claude-haiku-5-5", "code": "claude-sonnet-5-5", "vision": "claude-sonnet-5-5"},
        supports_vision=True,
    ),
    ProviderConfig(
        id="openai",
        api_format="openai_chat",
        base_url="https://api.openai.com/v1",
        api_key_env="OPENAI_API_KEY",
        models={"smart": "gpt-5", "fast": "gpt-5-mini", "code": "gpt-5", "vision": "gpt-5"},
        supports_vision=True,
        supports_embeddings=True,
        embedding_model="text-embedding-3-small",
    ),
    ProviderConfig(
        id="openrouter",
        api_format="openai_chat",
        base_url="https://openrouter.ai/api/v1",
        api_key_env="OPENROUTER_API_KEY",
        models={"smart": "anthropic/claude-sonnet-5.5", "fast": "deepseek/deepseek-v4-flash", "code": "anthropic/claude-sonnet-5.5"},
        headers={"HTTP-Referer": "https://github.com/Micka420-collab/Super_agent_mc", "X-Title": "EMETH"},
    ),
    ProviderConfig(
        id="ollama",
        api_format="openai_chat",
        base_url="http://127.0.0.1:11434/v1",
        models={"smart": "qwen3:14b", "fast": "qwen3:8b", "code": "qwen3-coder:30b", "vision": "qwen3-vl:8b"},
        supports_vision=True,
        supports_embeddings=True,
        embedding_model="nomic-embed-text",
        supports_json_schema=False,
        timeout_s=180.0,
    ),
]


def load_providers(path: Path | None) -> list[ProviderConfig]:
    """Load providers from YAML (list under `providers:`) or return the defaults."""
    if path is None or not path.exists():
        return list(DEFAULT_PROVIDERS)
    import yaml

    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    items = raw.get("providers", raw if isinstance(raw, list) else [])
    return [ProviderConfig.model_validate(item) for item in items]
