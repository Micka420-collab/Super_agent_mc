"""EMETH command line.

  emeth run                 start the mind (connects to the body bridge)
  emeth mcp                 serve the running mind as an MCP tool server on stdio (Claude Code / Desktop / Codex)
  emeth doctor              check providers, body connection, data dir
  emeth prompt-stats        size (chars/tokens) of a decision prompt from the protocol fixtures
  emeth soul export DIR     export the portable soul bundle
  emeth soul import DIR     import a soul bundle into this data dir
  emeth memory search Q     search semantic memory
  emeth skills list         list learned skills
  emeth persona init PATH   write a persona template
  emeth design "brief"      design a structure with the architect and print its layers (dry run)
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from emeth.config import Settings, load_providers

app = typer.Typer(no_args_is_help=True, help="EMETH — autonomous Minecraft player (mind)")
soul_app = typer.Typer(help="Portable identity bundles")
memory_app = typer.Typer(help="Inspect memory")
skills_app = typer.Typer(help="Skill library")
persona_app = typer.Typer(help="Persona files")
app.add_typer(soul_app, name="soul")
app.add_typer(memory_app, name="memory")
app.add_typer(skills_app, name="skills")
app.add_typer(persona_app, name="persona")
console = Console()


def _settings() -> Settings:
    s = Settings()
    logging.basicConfig(level=getattr(logging, s.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return s


@app.command()
def run() -> None:
    """Start the mind and keep it alive."""
    from emeth.runtime import build_mind

    settings = _settings()
    mind = build_mind(settings)

    async def main() -> None:
        loop = await mind.start()
        console.print(f"[bold green]EMETH[/] mind online as [bold]{mind.identity.name}[/] (autonomy {mind.identity.level.name}) — body {mind.body.hello.minecraft if mind.body.hello else '?'}")
        try:
            await loop.run()
        finally:
            await mind.close()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        console.print("bye")


@app.command()
def mcp(
    url: str | None = typer.Option(None, help="control channel URL (default from EMETH_CONTROL_HOST/PORT)"),
    token: str | None = typer.Option(None, help="control token (default EMETH_CONTROL_TOKEN or data/control.token)"),
) -> None:
    """Serve EMETH as an MCP tool server on stdio (Claude Code: `claude mcp add emeth -- emeth mcp`)."""
    from emeth.control import ControlClient
    from emeth.mcp.server import serve_stdio

    s = Settings()
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)  # stdout belongs to the protocol
    target = url or f"ws://{s.control_host}:{s.control_port}"
    secret = token or s.control_token
    if not secret:
        path = s.control_token_path()
        if path.exists():
            secret = path.read_text(encoding="utf-8").strip()
    if not secret:
        typer.echo("no control token: start the mind first (`emeth run`) or set EMETH_CONTROL_TOKEN", err=True)
        raise typer.Exit(2)
    asyncio.run(serve_stdio(ControlClient(target, secret)))


@app.command(name="prompt-stats")
def prompt_stats(observation: Path | None = typer.Option(None, help="observation JSON (default: protocol fixture)")) -> None:
    """Size of a decision prompt, block by block — what one thought costs before any key is spent."""
    from emeth.cognition.decide import manifest_text, system_prompt
    from emeth.memory.context import ContextBlocks, observation_blocks
    from emeth.protocol import HelloResult, Observation
    from emeth.self.identity import Identity
    from emeth.social.persona import load_persona

    s = Settings()
    fixtures = Path(__file__).resolve().parents[3] / "protocol" / "fixtures"
    obs_path = observation or fixtures / "observation.json"
    obs = Observation.model_validate(json.loads(obs_path.read_text(encoding="utf-8")))
    hello = HelloResult.model_validate(json.loads((fixtures / "hello.json").read_text(encoding="utf-8")))
    persona = load_persona(s.persona_path)
    identity = Identity(name=persona.name)
    system = system_prompt(persona.render(), manifest_text(hello.actions), s.language, identity.level.frame)
    blocks = ContextBlocks(**observation_blocks(obs, "quiet moment"))
    blocks.identity = identity.render()
    blocks.decision = "Decide what to do right now."
    context = blocks.render()
    tokens = lambda text: round(len(text) / 3.6)  # noqa: E731 - rough, prose + JSON mix
    console.print(f"[bold]system prompt[/]: {len(system):,} chars ≈ {tokens(system):,} tokens (cached across decisions) — {len(hello.actions)} primitives in the manifest")
    console.print(f"[bold]context (this observation)[/]: {len(context):,} chars ≈ {tokens(context):,} tokens")
    for name, text in [("identity", blocks.identity), ("sensory", blocks.sensory), ("entities", blocks.entities), ("blocks", blocks.blocks), ("inventory", blocks.inventory)]:
        console.print(f"  {name:<10} {len(text):>6,} chars ≈ {tokens(text):>5,} tok")
    console.print("[dim]memory, timeline, goals and players grow with the agent's life — budgets per block in memory/context.py[/]")
    console.print(f"[bold]max output[/]: {s.loop.max_decision_tokens} tokens · [bold]rate[/]: ≤ {s.loop.max_requests_per_minute} requests/min")


@app.command()
def doctor() -> None:
    """Check configuration: providers, keys, body bridge reachability."""
    from emeth.llm.router import LLMRouter

    settings = _settings()
    settings.ensure_dirs()
    providers = load_providers(settings.providers_path)
    router = LLMRouter.from_configs(providers)
    table = Table(title="LLM providers")
    table.add_column("id")
    table.add_column("format")
    table.add_column("base_url")
    table.add_column("key")
    table.add_column("tiers")
    for p in router.providers.values():
        table.add_row(p.id, p.config.api_format, p.config.base_url, "✓" if p.available() else "missing", ", ".join(f"{k}={v}" for k, v in p.config.models.items()))
    console.print(table)
    if not any(p.available() for p in router.providers.values()):
        console.print("[red]No provider available: set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY or run Ollama locally.[/]")

    async def ping() -> None:
        from emeth.bridge.client import BodyClient, websocket_factory

        client = BodyClient(websocket_factory(settings.bridge_url, settings.bridge_token))
        try:
            await asyncio.wait_for(client.connect(), timeout=5)
            hello = client.hello
            console.print(f"[green]Body reachable[/] at {settings.bridge_url}: {hello.body if hello else ''} — MC {hello.minecraft if hello else ''} — {len(hello.actions) if hello else 0} actions, vision={hello.capabilities.get('vision') if hello else '?'}")
            await client.close()
        except Exception as exc:  # noqa: BLE001
            console.print(f"[yellow]Body not reachable[/] at {settings.bridge_url}: {exc}")

    asyncio.run(ping())

    async def control() -> None:
        from emeth.control import ControlClient, ControlError

        token_path = settings.control_token_path()
        token = settings.control_token or (token_path.read_text(encoding="utf-8").strip() if token_path.exists() else "")
        url = f"ws://{settings.control_host}:{settings.control_port}"
        if not token:
            console.print(f"[dim]No running mind yet (no control token at {token_path}); `emeth run` creates one.[/]")
            return
        try:
            status = await ControlClient(url, token, timeout_s=5).call("status")
            console.print(f"[green]Mind running[/] at {url}: {status['name']} ({status['autonomy']['stage']}), body {'connected' if status['body']['connected'] else 'disconnected'} — dashboard {url.replace('ws://', 'http://')}/?token=… · MCP: `claude mcp add emeth -- emeth mcp`")
        except ControlError as exc:
            console.print(f"[dim]No mind answering at {url} ({exc.code}); start it with `emeth run`.[/]")

    asyncio.run(control())
    console.print(f"data dir: {settings.data_dir.resolve()} — skills: {Path(settings.skills_dir).resolve()}")


@soul_app.command("export")
def soul_export(out: Path = typer.Argument(..., help="output directory")) -> None:
    from emeth.memory.soul import export_soul
    from emeth.runtime import build_mind

    settings = _settings()
    mind = build_mind(settings)
    path = export_soul(out, mind.store, mind.identity, mind.wiki, mind.graph, mind.skills)
    console.print(f"soul exported to {path.resolve()}")


@soul_app.command("import")
def soul_import(src: Path = typer.Argument(..., help="bundle directory"), name: str | None = typer.Option(None, help="rename the agent")) -> None:
    from emeth.memory.soul import import_soul
    from emeth.runtime import build_mind

    settings = _settings()
    mind = build_mind(settings)
    identity = asyncio.run(import_soul(src, mind.store, mind.wiki, mind.graph, mind.skills, name=name))
    console.print(f"soul imported: {identity.name}, autonomy {identity.level.name}, experience {identity.metrics.experience():.0f}")


@memory_app.command("search")
def memory_search(query: str, limit: int = 8) -> None:
    from emeth.runtime import build_mind

    settings = _settings()
    mind = build_mind(settings)
    pages = asyncio.run(mind.wiki.search(query, limit=limit))
    for p in pages:
        console.print(f"[bold]{p.title}[/] [{p.kind}] score={p.score:.3f} — {p.abstract[:120]}")
    if not pages:
        console.print("(no pages)")


@memory_app.command("timeline")
def memory_timeline(limit: int = 40) -> None:
    from emeth.runtime import build_mind

    settings = _settings()
    mind = build_mind(settings)
    for e in mind.store.recent_episodes(limit=limit):
        console.print(f"{e.kind:12} {e.text}")


@memory_app.command("graph")
def memory_graph() -> None:
    from emeth.runtime import build_mind

    settings = _settings()
    mind = build_mind(settings)
    console.print(json.dumps(mind.graph.stats(), indent=2))
    for r in mind.graph.region_summary()[:10]:
        console.print(r)


@skills_app.command("list")
def skills_list() -> None:
    from emeth.runtime import build_mind

    settings = _settings()
    mind = build_mind(settings)
    asyncio.run(mind.skills.sync_from_disk())
    table = Table(title="Skills")
    for col in ("name", "uses", "success", "version", "description"):
        table.add_column(col)
    for r in mind.skills.records():
        table.add_row(r.name, str(r.uses), f"{r.success_rate:.0%}", str(r.version), r.description[:80])
    console.print(table)


@persona_app.command("init")
def persona_init(path: Path = typer.Argument(Path("persona.yaml"))) -> None:
    from emeth.social.persona import save_persona_template

    save_persona_template(path)
    console.print(f"persona template written to {path}")


@app.command()
def design(brief: str, width: int = 9, height: int = 7, depth: int = 9) -> None:
    """Dry-run the architect: design a structure and print its ASCII layers."""
    from emeth.builder.designer import Designer
    from emeth.llm.router import LLMRouter

    settings = _settings()
    router = LLMRouter.from_configs(load_providers(settings.providers_path))
    result = asyncio.run(Designer(router).design(brief, max_size=(width, height, depth)))
    if result.ok and result.blueprint:
        console.print(f"[green]{result.spec.name if result.spec else result.blueprint.name}[/] — {len(result.blueprint.solid)} blocks, size {result.blueprint.size}, attempts {result.attempts}")
        console.print(result.blueprint.ascii_layers())
        console.print(result.blueprint.bill_of_materials())
    else:
        console.print(f"[red]design failed[/]: {result.error} — critiques: {result.critiques}")


if __name__ == "__main__":
    app()
