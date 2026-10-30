"""Assemble a complete mind from settings — one place that knows how the pieces fit."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from emeth.bridge.client import BodyClient, TransportFactory, websocket_factory
from emeth.builder.designer import Designer
from emeth.cognition.construction import Constructor
from emeth.cognition.critic import Critic
from emeth.cognition.drives import Drives
from emeth.cognition.loop import CognitiveLoop
from emeth.cognition.planner import Planner
from emeth.cognition.skills import SkillSynthesizer
from emeth.config import Settings, load_providers
from emeth.control import ControlAPI, ControlServer
from emeth.llm.embeddings import Embedder
from emeth.llm.router import LLMRouter
from emeth.memory.consolidation import Consolidator
from emeth.memory.episodic import Timeline
from emeth.memory.procedural import SkillLibrary
from emeth.memory.semantic import Wiki
from emeth.memory.social import SocialMemory
from emeth.memory.spatial import WorldGraph
from emeth.memory.store import MemoryStore
from emeth.self.identity import Identity
from emeth.social.persona import Persona, load_persona

log = logging.getLogger(__name__)


@dataclass
class Mind:
    settings: Settings
    persona: Persona
    store: MemoryStore
    router: LLMRouter
    embedder: Embedder
    wiki: Wiki
    timeline: Timeline
    social: SocialMemory
    graph: WorldGraph
    skills: SkillLibrary
    identity: Identity
    planner: Planner
    drives: Drives
    consolidator: Consolidator
    critic: Critic
    body: BodyClient
    loop: CognitiveLoop | None = None
    control: ControlServer | None = None

    async def start(self) -> CognitiveLoop:
        await self.body.connect()
        if self.settings.control_enabled:
            self.control = ControlServer(ControlAPI(self), self.settings.control_host, self.settings.control_port, self.settings.control_token)
            await self.control.start()
            self.control.write_token(self.settings.control_token_path())
        await self.skills.sync_from_disk()
        synthesizer = SkillSynthesizer(self.router, self.body, self.skills, max_attempts=self.settings.loop.max_skill_attempts)
        constructor = Constructor(Designer(self.router), self.body)
        self.loop = CognitiveLoop(
            body=self.body,
            router=self.router,
            store=self.store,
            wiki=self.wiki,
            timeline=self.timeline,
            social=self.social,
            graph=self.graph,
            identity=self.identity,
            persona=self.persona,
            planner=self.planner,
            drives=self.drives,
            consolidator=self.consolidator,
            synthesizer=synthesizer,
            critic=self.critic,
            config=self.settings.loop,
            language=self.settings.language,
            constructor=constructor,
        )
        return self.loop

    async def close(self) -> None:
        if self.loop:
            self.loop.stop()
        if self.control:
            await self.control.stop()
        await self.body.close()
        await self.router.aclose()
        self.graph.save()
        self.identity.save(self.store)
        self.planner.save()
        self.store.close()


def build_mind(settings: Settings, *, router: LLMRouter | None = None, transport: TransportFactory | None = None, persona: Persona | None = None) -> Mind:
    settings.ensure_dirs()
    persona = persona or load_persona(settings.persona_path)
    store = MemoryStore(settings.data_dir / "memory.sqlite")
    if router is None:
        router = LLMRouter.from_configs(load_providers(settings.providers_path), tier_preferences=settings.tier_preferences, max_requests_per_minute=settings.loop.max_requests_per_minute, log_path=settings.data_dir / "logs" / "decisions.jsonl")
    embedder = Embedder(router)
    wiki = Wiki(settings.data_dir / "wiki", store, embedder)
    timeline = Timeline(store)
    social = SocialMemory(store, owner=persona.owner)
    graph = WorldGraph(settings.data_dir / "world-graph.json")
    skills = SkillLibrary(Path(settings.skills_dir), store, embedder)
    identity = Identity.load(store, persona.name)
    planner = Planner(store)
    drives = Drives()
    consolidator = Consolidator(router, store, wiki, timeline, social, graph, skills, identity, language=settings.language)
    critic = Critic(router)
    body = BodyClient(transport or websocket_factory(settings.bridge_url, settings.bridge_token))
    return Mind(settings, persona, store, router, embedder, wiki, timeline, social, graph, skills, identity, planner, drives, consolidator, critic, body)
