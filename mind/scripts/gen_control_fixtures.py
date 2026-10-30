"""Generate the control-channel fixtures shared with the Paper companion plugin.

    cd mind && python scripts/gen_control_fixtures.py ../protocol/fixtures/control

A mind is built on the test fakes (scripted brain, simulated body), thinks once, and the answers of the methods the
plugin calls (`status`, `goals`, `timeline`, `render`) are written as JSON. The Java tests parse them, and the Python
tests check that a live `status` still has every key the fixture has: if the mind's answer drifts, one suite breaks.
Volatile values (timestamps, latencies) are normalised so the files only change when the shape does.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

MIND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MIND_DIR))

from emeth.config import Settings  # noqa: E402
from emeth.control import ControlAPI  # noqa: E402
from emeth.llm.mock import MockProvider  # noqa: E402
from emeth.llm.router import LLMRouter  # noqa: E402
from emeth.runtime import build_mind  # noqa: E402
from tests.fakes import FakeWorld, fake_transport_factory  # noqa: E402
from tests.test_loop import scripted_brain  # noqa: E402

VOLATILE = {"ts", "at", "started_at", "created_at", "startedAt", "last_ok", "last_error_at", "latency_ms", "avg_latency_ms", "opened_at"}


def normalise(value: Any, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: normalise(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalise(v) for v in value]
    if key in VOLATILE and isinstance(value, (int, float)) and not isinstance(value, bool):
        return 1_700_000_000.0 if key in {"ts", "at", "started_at", "created_at", "startedAt"} else 0
    return value


async def collect() -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        settings = Settings(data_dir=root / "data", skills_dir=root / "skills", control_enabled=False, providers_path=None)
        router = LLMRouter([MockProvider("brain", script=scripted_brain)], max_requests_per_minute=1000)
        mind = build_mind(settings, router=router, transport=fake_transport_factory(FakeWorld()))
        await mind.start()
        try:
            assert mind.loop is not None
            await mind.body.observe("compact")
            await mind.loop.think("startup")
            await asyncio.sleep(0.2)
            api = ControlAPI(mind)
            return {
                "status": await api.dispatch("status", {}),
                "goals": await api.dispatch("goals", {}),
                "timeline": await api.dispatch("timeline", {"limit": 12}),
                "render": await api.dispatch("render", {"width": 8, "height": 4}),
            }
        finally:
            await mind.close()


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else MIND_DIR.parent / "protocol" / "fixtures" / "control")
    out.mkdir(parents=True, exist_ok=True)
    data = asyncio.run(collect())
    for name, value in data.items():
        (out / f"{name}.json").write_text(json.dumps(normalise(value), indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {len(data)} control fixtures to {out}")


if __name__ == "__main__":
    main()
