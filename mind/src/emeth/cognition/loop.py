"""The cognitive loop — event-driven, one decision in flight, body acting asynchronously.

    wake (chat / hurt / result / timer / nightfall / ...) → perceive → appraise → decide → execute
                                          ↑                                            |
                                          └──────────── body events & results ─────────┘

Design choices (from the research synthesis):
  * VoxelMind: purely event-driven with debounce; timer wakes are opportunities, not obligations.
  * ChatClef: command feedback ("X finished, what next?") re-enters the loop so multi-step goals chain.
  * Voyager: tasks are verified by a critic before they count; skills are synthesised on demand.
  * PIANO: speech and action come from one decision so what the agent says matches what it does.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any

from emeth.bridge.client import BodyClient, BodyEvent
from emeth.cognition.construction import ConstructionOutcome, Constructor
from emeth.cognition.critic import Critic
from emeth.cognition.decide import (
    Decision,
    build_request,
    describe_decision,
    manifest_text,
    parse_decision,
    system_prompt,
)
from emeth.cognition.drives import Drives
from emeth.cognition.instinct import InstinctContext, instinct
from emeth.cognition.planner import Planner, Task
from emeth.cognition.reflection import Reflection, signature_of
from emeth.cognition.skills import SkillOutcome, SkillSynthesizer
from emeth.config import LoopConfig
from emeth.llm.router import LLMRouter
from emeth.llm.types import LLMError
from emeth.memory.consolidation import Consolidator
from emeth.memory.context import ContextBlocks, minutes_to, observation_blocks, render_action_result
from emeth.memory.episodic import Timeline
from emeth.memory.semantic import Wiki
from emeth.memory.social import SocialMemory
from emeth.memory.spatial import WorldGraph
from emeth.memory.store import MemoryStore
from emeth.protocol import ActionResult, BodyError, Observation, SkillRunResult
from emeth.self.identity import Identity
from emeth.social.persona import Persona

log = logging.getLogger(__name__)

COORD_HINT = re.compile(r"-?\d{1,5}\s*[, ]\s*-?\d{1,3}\s*[, ]\s*-?\d{1,5}")


@dataclass
class LoopStats:
    decisions: int = 0
    actions: int = 0
    skills: int = 0
    speeches: int = 0
    dreams: int = 0
    errors: int = 0
    instinct_decisions: int = 0
    started_at: float = field(default_factory=time.time)


class CognitiveLoop:
    def __init__(
        self,
        *,
        body: BodyClient,
        router: LLMRouter,
        store: MemoryStore,
        wiki: Wiki,
        timeline: Timeline,
        social: SocialMemory,
        graph: WorldGraph,
        identity: Identity,
        persona: Persona,
        planner: Planner,
        drives: Drives,
        consolidator: Consolidator,
        synthesizer: SkillSynthesizer | None,
        critic: Critic,
        config: LoopConfig | None = None,
        language: str = "fr",
        constructor: Constructor | None = None,
    ):
        self.body = body
        self.router = router
        self.store = store
        self.wiki = wiki
        self.timeline = timeline
        self.social = social
        self.graph = graph
        self.identity = identity
        self.persona = persona
        self.planner = planner
        self.drives = drives
        self.consolidator = consolidator
        self.synthesizer = synthesizer
        self.constructor = constructor
        self.critic = critic
        self.cfg = config or LoopConfig()
        self.language = language
        self.stats = LoopStats()
        self._wake = asyncio.Event()
        self._reasons: list[str] = []
        self._thinking = asyncio.Lock()
        self._stop = asyncio.Event()
        self._action_task: asyncio.Task[Any] | None = None
        self._action_label: str = ""
        self._task_before: Observation | None = None
        self._last_result: ActionResult | SkillRunResult | None = None
        self._last_result_text: str = "No action yet."
        self._system_prompt: str | None = None
        self._last_day: int | None = None
        self._last_decision_at: float = 0.0
        self._consecutive_bad_decisions = 0
        self._wait_until: float = 0.0
        # metacognition: notices repeated failures and rejected thoughts, writes [REFLECTION]
        self.reflection = Reflection()
        self._action_sig: str = ""
        # the latest valid thought, for the in-game companion plugin and the dashboard ("what is it thinking?")
        self._last_thought: str = ""
        self._last_intent: str = ""
        self._last_speech: str = ""
        # words from outside the game (the owner through the MCP façade / dashboard), consumed by the next thought
        self._mentor_inbox: list[tuple[str, str]] = []

    # ---------------------------------------------------------------------------------------
    # lifecycle
    # ---------------------------------------------------------------------------------------
    async def run(self) -> None:
        await self.body.configure_stream(hz=0.5, detail="compact")
        if self.persona.owner:
            with contextlib.suppress(Exception):
                await self.body.configure_reflexes(allies=[self.persona.owner])
        consumer = asyncio.create_task(self._consume_events(), name="event-consumer")
        self.timeline.add("note", f"mind online as {self.identity.name} (autonomy {self.identity.level.name})")
        self.wake("startup")
        try:
            while not self._stop.is_set():
                timeout = self._next_timer()
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=timeout)
                    reasons = self._drain_reasons()
                except TimeoutError:
                    reasons = ["quiet moment" if self._action_task else "idle body"]
                if time.time() < self._wait_until and not any(r.startswith(("chat", "whisper", "hurt", "death", "threat")) for r in reasons):
                    continue  # honouring a deliberate wait
                try:
                    await self.think(", ".join(reasons))
                except LLMError as exc:
                    self.stats.errors += 1
                    log.error("decision failed: %s", exc)
                    self.timeline.add("note", f"my language mind is unavailable ({str(exc)[:100]}) — instinct takes over")
                    try:
                        await self.act_on_instinct(", ".join(reasons))
                    except Exception as inner:  # noqa: BLE001
                        log.exception("instinct failed: %s", inner)
                    await asyncio.sleep(10)
                except Exception as exc:  # noqa: BLE001
                    self.stats.errors += 1
                    log.exception("think() crashed: %s", exc)
                    await asyncio.sleep(3)
        finally:
            consumer.cancel()
            if self._action_task:
                self._action_task.cancel()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def wake(self, reason: str) -> None:
        self._reasons.append(reason)
        self._wake.set()

    def _drain_reasons(self) -> list[str]:
        reasons, self._reasons = list(dict.fromkeys(self._reasons)), []
        self._wake.clear()
        return reasons or ["unknown"]

    def _next_timer(self) -> float:
        urgency = self.drives.wake_priority()
        if self._action_task:
            lo, hi = self.cfg.quiet_moment_min_s, self.cfg.quiet_moment_max_s
        else:
            lo, hi = self.cfg.idle_body_min_s, self.cfg.idle_body_max_s
        base = random.uniform(lo, hi)
        return max(5.0, base * (1 - 0.7 * urgency))

    # ---------------------------------------------------------------------------------------
    # events
    # ---------------------------------------------------------------------------------------
    async def _consume_events(self) -> None:
        debounce: dict[str, float] = {}
        while not self._stop.is_set():
            ev = await self.body.events.get()
            try:
                wake_reason, delay_ms = self._handle_event(ev)
            except Exception as exc:  # noqa: BLE001
                log.warning("event handling failed for %s: %s", ev.event, exc)
                continue
            if wake_reason:
                key = wake_reason.split(":")[0]
                now = time.time()
                if now - debounce.get(key, 0) >= delay_ms / 1000:
                    debounce[key] = now
                    self.wake(wake_reason)

    def _handle_event(self, ev: BodyEvent) -> tuple[str | None, int]:
        p = ev.payload if isinstance(ev.payload, dict) else {}
        kind = ev.event
        if kind == "chat":
            speaker, text = str(p.get("from", "?")), str(p.get("text", ""))
            self.timeline.add("chat_in", f"{speaker}: {text}", actors=[speaker])
            self.social.on_chat(speaker, text)
            self.drives.on_event("chat_in")
            if self.persona.addressed(text, speaker) or random.random() < self.persona.chattiness * 0.5:
                return f"chat from {speaker}", self.cfg.debounce_chat_ms
            return None, 0
        if kind == "whisper":
            speaker, text = str(p.get("from", "?")), str(p.get("text", ""))
            self.timeline.add("whisper_in", f"{speaker} (private): {text}", actors=[speaker])
            self.social.on_chat(speaker, text)
            self.drives.on_event("whisper_in")
            return f"whisper from {speaker}", self.cfg.debounce_chat_ms
        if kind == "hurt":
            src = p.get("source") if isinstance(p.get("source"), dict) else None
            who = (src or {}).get("username") or (src or {}).get("name") or "something"
            self.timeline.add("damage", f"hurt by {who} (health {p.get('health', '?')})", actors=[who] if src else [])
            self.drives.on_event("damage")
            if src and src.get("kind") == "player" and src.get("username"):
                self.social.on_attacked_by(str(src["username"]))
            return f"hurt by {who}", self.cfg.debounce_hurt_ms
        if kind == "death":
            pos = p.get("position") if isinstance(p.get("position"), dict) else None
            where = f" at ({pos['x']}, {pos['y']}, {pos['z']})" if pos else ""
            self.timeline.add("death", f"I died{where}", importance=0.9)
            self.drives.on_event("death")
            self.identity.bump(deaths=1)
            self.identity.save(self.store)
            self._cancel_action("death")
            if pos:
                # a real player goes back for their things: the drops last five minutes
                try:
                    x, y, z = float(pos["x"]), float(pos["y"]), float(pos["z"])
                    self.graph.mark_place("where I died", x, y, z, kind="place", notes="my items dropped here")
                    title = f"Recover my belongings where I died ({x:.0f}, {y:.0f}, {z:.0f})"
                    if not any(g.title == title and g.status == "active" for g in self.planner.goals):
                        self.planner.add_goal(title, [Task(description=f"go back to ({x:.0f}, {y:.0f}, {z:.0f}) within 5 minutes and pick up my dropped items (collect_items), carefully — whatever killed me may still be there", kind="explore", max_attempts=2)], why="items despawn five minutes after death", priority=2, source="self")
                        self.timeline.add("plan", "new goal: recover my belongings where I died", importance=0.6)
                except (KeyError, TypeError, ValueError):
                    pass
            asyncio.create_task(self._respawn_later())
            return "death", 0
        if kind == "respawn":
            self.timeline.add("respawn", "respawned")
            return "respawn", 500
        if kind == "entity.spawn":
            label = p.get("username") or p.get("name", "?")
            if p.get("kind") == "player":
                self.timeline.add("presence", f"{label} came into view ({p.get('distance', '?')}m {p.get('relative', '')})", actors=[str(label)])
                self.social.on_seen(str(label))
                return f"player near: {label}", 1500
            self.timeline.add("threat", f"{label} appeared {p.get('distance', '?')}m {p.get('relative', '')}")
            return f"threat: {label}", 2000
        if kind == "player.joined":
            self.timeline.add("presence", f"{p.get('username')} joined the server", actors=[str(p.get("username"))])
            self.drives.on_event("player.joined")
            return f"player joined: {p.get('username')}", 3000
        if kind == "player.left":
            self.timeline.add("presence", f"{p.get('username')} left the server")
            return None, 0
        if kind == "player.activity":
            return self._on_player_activity(p)
        if kind == "item.collected":
            self.timeline.add("result", f"picked up {p.get('count')} {p.get('name')}", importance=0.15)
            return None, 0
        if kind == "reflex":
            if p.get("phase") == "start":
                self.timeline.add("reflex", f"my body reacted: {p.get('name')} ({p.get('reason')})")
                return None, 0
            self.timeline.add("reflex", f"reflex {p.get('name')} ended ({'ok' if p.get('ok') else 'failed'}, health {p.get('health', '?')})")
            return f"reflex: {p.get('name')}", 800
        if kind == "action.interrupted":
            self.timeline.add("note", f"my action {p.get('action')} was interrupted: {p.get('reason')}")
            return None, 0
        if kind == "sleep":
            self.timeline.add("sleep", f"fell asleep on day {p.get('day')}")
            self.drives.on_event("sleep")
            self.planner.mark_slept()
            self._mark_home()
            asyncio.create_task(self._dream(int(p.get("day") or 0)))
            return None, 0
        if kind == "wake":
            self.timeline.add("wake", "woke up")
            return "woke up", 0
        if kind == "nightfall":
            self.timeline.add("note", "night is falling")
            return "nightfall", 0
        if kind == "daybreak":
            self.timeline.add("note", f"day {p.get('day')} begins")
            day = int(p.get("day") or 0)
            if self._last_day is not None and day > self._last_day:
                self.identity.bump(days_survived=day - self._last_day)
                self.identity.save(self.store)
            self._last_day = day
            return "daybreak", 0
        if kind in ("kicked", "disconnected"):
            self.timeline.add("note", f"connection lost ({kind}): {p.get('reason', '')}")
            self._cancel_action(kind)
            return None, 0
        if kind == "reconnected":
            self.timeline.add("note", "reconnected to my body")
            return "reconnected", 0
        return None, 0

    def _on_player_activity(self, p: dict[str, Any]) -> tuple[str | None, int]:
        """Someone built or dug nearby: remember it as an observation, on the person and on the map."""
        who = str(p.get("username") or "someone")
        text = str(p.get("text") or f"{who} worked on some blocks")
        count = int(p.get("count") or 0)
        verb = "built" if p.get("kind") == "built" else "dug"
        self.timeline.add("observed", text, actors=[who], importance=0.3 if count < 20 else 0.5)
        self.social.on_seen(who)
        if count >= 12 and verb == "built":
            mn, mx = p.get("min") or {}, p.get("max") or {}
            try:
                cx, cy, cz = (float(mn["x"]) + float(mx["x"])) / 2, (float(mn["y"]) + float(mx["y"])) / 2, (float(mn["z"]) + float(mx["z"])) / 2
                blocks = p.get("blocks") or {}
                main = ", ".join(f"{c} {n}" for n, c in sorted(dict(blocks).items(), key=lambda kv: -int(kv[1]))[:3])
                self.graph.mark_place(f"{who}'s build", cx, cy, cz, kind="structure", notes=f"seen being built by {who}: {main}")
                self.social.remember(who, f"builds things ({main})")
            except (KeyError, TypeError, ValueError):
                pass
            self.drives.on_event("discovery")
            return f"{who} is building nearby", 5000
        return None, 0

    def _mark_home(self) -> None:
        """Where I sleep is home: the place the mind steers back to before dark."""
        obs = self.body.latest_observation
        if obs is None:
            return
        pos = obs.self_.position
        self.graph.mark_place("home", pos.x, pos.y, pos.z, kind="place", dim=obs.self_.dimension, notes="my bed — where I sleep")
        self.timeline.add("note", f"home is where I sleep: ({pos.x:.0f}, {pos.y:.0f}, {pos.z:.0f})", importance=0.5)

    def home_advice(self, obs: Observation) -> str:
        """A player keeps an eye on the clock and the distance to their bed."""
        rows = self.graph.nearest(obs.self_.position.x, obs.self_.position.y, obs.self_.position.z, kind="place", label="home", dim=obs.self_.dimension, limit=1)
        if not rows:
            return ""
        node, dist = rows[0]
        walk_min = max(1, round(dist / 4.3 / 60 + 0.5))  # ~4.3 blocks/s walking
        where = f"Home is at ({node.x:.0f}, {node.y:.0f}, {node.z:.0f}), {dist:.0f} blocks away (~{walk_min} min walk)."
        w = obs.world
        if w.phase == "day":
            left = minutes_to(w.timeOfDay, 12000)
            if dist > 24 and walk_min + 1 >= left:
                return f"{where} Dusk in ~{left} min: head back now or you will be out in the dark."
            return where if dist > 24 else ""
        if w.phase == "dusk":
            return f"{where} Night is coming: go home or raise a shelter here." if dist > 16 else where
        if w.phase == "night" and dist > 32 and not obs.self_.isSleeping:
            return f"{where} It is night and you are far from your bed: shelter where you are (or dig in) rather than crossing the dark."
        return ""

    async def _respawn_later(self) -> None:
        await asyncio.sleep(3)
        with contextlib.suppress(Exception):
            await self.body.act("respawn")

    async def _dream(self, day: int) -> None:
        try:
            res = await self.consolidator.dream(day)
            self.stats.dreams += 1
            self.timeline.add("note", f"I dreamt: {res.lessons} lessons, {res.places} places, {res.people} people remembered" + (f", retired skills {res.retired_skills}" if res.retired_skills else ""))
            await self._maybe_write_diary(res.session_page)
        except Exception as exc:  # noqa: BLE001
            log.warning("dream failed: %s", exc)

    async def _maybe_write_diary(self, session_page: str | None) -> None:
        """If I carry a writable book, my diary becomes a real Minecraft book players can read."""
        if not session_page:
            return
        obs = self.body.latest_observation
        if not obs or obs.inventory.count("writable_book") == 0:
            return
        page = self.wiki.read(session_page)
        if not page:
            return
        chunks = [page.body[i : i + 240] for i in range(0, min(len(page.body), 240 * 20), 240)]
        with contextlib.suppress(Exception):
            await self.body.act("write_book", {"pages": chunks or ["(empty day)"]})
            self.timeline.add("note", "wrote today's story in my diary book")

    # ---------------------------------------------------------------------------------------
    # thinking
    # ---------------------------------------------------------------------------------------
    async def think(self, woke_by: str) -> None:
        async with self._thinking:
            obs = await self.body.observe("compact")
            self._appraise(obs, woke_by)
            if self.timeline.since_rewrite() >= self.cfg.memory_rewrite_every_events:
                asyncio.create_task(self.consolidator.rewrite_rolling())
            self._ensure_goal(obs)
            context = await self._context(obs, woke_by)
            decision = await self._decide(context)
            self.stats.decisions += 1
            self.identity.metrics.decisions += 1
            self._last_decision_at = time.time()
            await self._execute(decision, obs)

    async def act_on_instinct(self, woke_by: str) -> Decision:
        """Deterministic fallback when no language model answers: same observation, same execution path."""
        async with self._thinking:
            obs = await self.body.observe("compact")
            self._appraise(obs, woke_by)
            self._ensure_goal(obs)
            library = self.synthesizer.library if self.synthesizer else None
            available = {r.name for r in library.records()} if library else set()
            decision = instinct(InstinctContext(obs=obs, planner=self.planner, busy=bool(self._action_task and not self._action_task.done()), available_skills=available, known_actions=self.body.action_names))
            self.stats.instinct_decisions += 1
            await self._execute(decision, obs)
            return decision

    def _appraise(self, obs: Observation, woke_by: str) -> None:
        s = obs.self_
        self.timeline.set_context(obs.world.day, (s.position.x, s.position.y, s.position.z), s.dimension)
        if self._last_day is None:
            self._last_day = obs.world.day
        new_nodes = self.graph.observe(obs)
        if new_nodes:
            self.drives.on_event("discovery")
            interesting = [n for n in new_nodes if n.startswith(("resource", "structure"))][:3]
            if interesting:
                labels = [self.graph.g.nodes[n]["label"] for n in interesting]
                self.timeline.add("discovery", f"noticed {', '.join(labels)} nearby", importance=0.5)
        self.drives.update(obs)
        for mid in self.planner.refresh_milestones(obs):
            self.timeline.add("achievement", f"milestone reached: {mid}", importance=0.8)
            self.drives.on_event("achievement")
            self.identity.bump(distinct_items_crafted=1)
        unlocked = self.identity.bump()
        if unlocked:
            self.timeline.add("achievement", f"I feel different… I have become a {unlocked.name} (autonomy level {unlocked.level})", importance=1.0)
        self.identity.save(self.store)

    def _ensure_goal(self, obs: Observation) -> None:
        if self.planner.current_task() is not None:
            return
        if self.identity.level.level < 1 and not self.persona.owner:
            pass  # newborns still get the first ladder steps
        task = self.planner.propose_curriculum_task()
        if task:
            self.planner.add_goal(f"Survival ladder: {task.description}", [task], why="progress through the basics of survival", priority=6, source="curriculum")
            self.timeline.add("plan", f"new goal: {task.description}")

    async def _context(self, obs: Observation, woke_by: str) -> str:
        blocks = ContextBlocks(**observation_blocks(obs, woke_by))
        blocks.identity = self.identity.render()
        blocks.drives = self.drives.state.render()
        blocks.body = self._body_block(obs)
        blocks.last_action = self._last_result_text
        blocks.goals = self.planner.render()
        previously, about = self.consolidator.rolling()
        blocks.previously = previously
        present = [p.username for p in obs.entities.players if p.username]
        blocks.about_players = (about + "\n" if about else "") + self.social.render_block(present)
        s = obs.self_.position
        blocks.places = self.graph.describe_near(s.x, s.y, s.z, dim=obs.self_.dimension, radius=96)
        query = " ".join(filter(None, [woke_by, (self.planner.current_task() or Task("")).description, obs.chat[-1].text if obs.chat else ""]))
        try:
            pages = await self.wiki.search(query, limit=5, kinds=["lesson", "concept", "project", "rule", "place"])
        except Exception:  # noqa: BLE001
            pages = []
        blocks.memories = self.wiki.brief(max_chars=2500, query_pages=pages)
        blocks.timeline = self.timeline.render()
        mentor = self._mentor_block()
        if mentor:
            blocks.extra["MENTOR"] = mentor
        reflection = self.reflection.render(self.planner.current_task())
        if reflection:
            blocks.extra["REFLECTION"] = reflection
        blocks.decision = self._decision_block(obs)
        return blocks.render()

    def _body_block(self, obs: Observation) -> str:
        if obs.action:
            running = f"My body is busy with `{obs.action.name}` (started {int(time.time() - obs.action.startedAt / 1000)}s ago)."
            return running + " Choose `keep` to let it finish, or another action to replace it."
        if self._action_task and not self._action_task.done():
            return f"My mind is working on: {self._action_label}. Choose `keep` to continue or replace it."
        return "My body is idle."

    def _decision_block(self, obs: Observation) -> str:
        lvl = self.identity.level
        parts = [
            "Decide what to do right now. One action, optional speech.",
            f"Max silence before I should at least check in with nearby players: {lvl.max_silence_s}s.",
        ]
        task = self.planner.current_task()
        if task:
            parts.append(f"Current task: {task.description}. Prefer `skill` with this task as the goal when it needs several steps, or a direct primitive when one step suffices.")
        if obs.world.phase in ("dusk", "night") and not obs.self_.isSleeping:
            parts.append("It is getting dark: shelter, light and sleep matter more than progress.")
        home = self.home_advice(obs)
        if home:
            parts.append(home)
        threat = obs.entities.threat
        if threat and threat.recommendation in ("retreat", "flee"):
            parts.append(f"My body reads the odds as {threat.recommendation.upper()} (danger {threat.danger:.0%}): {', '.join(threat.reasons[:3])}. Do not start a fight you cannot win.")
        if not lvl.may_wander_far:
            parts.append("Stay within ~60 blocks of players or home at this stage.")
        return "\n".join(parts)

    async def _decide(self, context: str) -> Decision:
        if self._system_prompt is None:
            manifest = manifest_text(self.body.hello.actions if self.body.hello else [])
            self._system_prompt = system_prompt(self.persona.render(), manifest, self.language, self.identity.level.frame)
        known = self.body.action_names
        temperature = self.reflection.temperature(0.5)
        req = build_request(self._system_prompt, context, max_tokens=self.cfg.max_decision_tokens, temperature=temperature)
        resp = await self.router.chat(req)
        decision = parse_decision(resp, known)
        if not decision.ok:
            self.timeline.add("note", f"my first thought was invalid ({'; '.join(decision.problems)[:120]}), thinking again")
            retry = build_request(self._system_prompt, context, max_tokens=self.cfg.max_decision_tokens, temperature=min(temperature, 0.2), retry_note="Your previous answer was rejected: " + "; ".join(decision.problems) + ". Answer again with a valid JSON decision.")
            resp = await self.router.chat(retry)
            decision = parse_decision(resp, known)
        return decision

    # ---------------------------------------------------------------------------------------
    # execution
    # ---------------------------------------------------------------------------------------
    async def _execute(self, d: Decision, obs: Observation) -> None:
        if not d.ok:
            self._consecutive_bad_decisions += 1
            self.reflection.decision_rejected(d.problems)
            self.timeline.add("note", f"could not form a valid decision: {'; '.join(d.problems)[:160]}")
            return
        self._consecutive_bad_decisions = 0
        self.reflection.decision_accepted()
        self.timeline.add("plan", f"{d.reason[:200]} → {describe_decision(d)}", importance=0.2)
        self._last_thought = d.reason[:300]
        self._last_intent = describe_decision(d)[:200]
        if d.speech:
            self._last_speech = d.speech[:240]
        if d.goal_update:
            self._apply_goal_update(d.goal_update)
        if d.remember:
            asyncio.create_task(self._remember(d.remember, obs))
        if d.speech:
            await self._say(d.speech, d.whisper_to, obs)
        if d.action_type == "primitive" and d.action_name:
            await self._start_action(d.action_name, d.action_args, obs)
        elif d.action_type == "skill" and d.skill_goal:
            await self._start_skill(d.skill_goal, obs)
        elif d.action_type == "stored_skill" and d.action_name:
            await self._start_stored_skill(d.action_name, d.action_args, obs)
        elif d.action_type == "design" and d.design_brief:
            await self._start_construction(d.design_brief, d.design_size, obs)
        elif d.action_type == "wait":
            self._wait_until = time.time() + d.wait_seconds
            self.timeline.add("action", f"waiting {d.wait_seconds}s" + (f" for {d.wait_for}" if d.wait_for else ""), importance=0.1)
            asyncio.get_running_loop().call_later(d.wait_seconds, lambda: self.wake("wait over"))
        # keep / none: nothing to do

    def _apply_goal_update(self, gu: dict[str, Any]) -> None:
        op, title = gu["op"], str(gu["title"])[:120]
        if op == "add":
            tasks = [Task(description=str(t)[:200], source="llm") for t in (gu.get("tasks") or []) if str(t).strip()] or [Task(description=title, source="llm")]
            self.planner.add_goal(title, tasks, why=str(gu.get("why", ""))[:200], priority=int(gu.get("priority") or 5), source="llm")
            self.timeline.add("plan", f"new goal: {title}")
        elif op == "complete":
            for g in self.planner.goals:
                if g.title == title and g.status == "active":
                    for t in g.tasks:
                        if t.status == "active":
                            t.status = "done"
                    g.status = "done"
                    self.planner.save()
                    self.timeline.add("achievement", f"goal completed: {title}", importance=0.7)
                    self.drives.on_event("achievement")
        elif op == "abandon":
            if self.planner.abandon_goal(title):
                self.timeline.add("plan", f"abandoned goal: {title}")

    async def _remember(self, text: str, obs: Observation) -> None:
        try:
            if COORD_HINT.search(text):
                await self.wiki.note("place", text[:60], text, tags=["place"], salience=0.6)
            else:
                await self.wiki.note("lesson", text[:60], text, tags=["note"], salience=0.5)
            self.timeline.add("note", f"noted: {text[:100]}", importance=0.3)
        except Exception as exc:  # noqa: BLE001
            log.debug("remember failed: %s", exc)

    async def _say(self, text: str, to: str | None, obs: Observation) -> None:
        try:
            await self.body.chat(text, to=to)
        except BodyError as exc:
            self.timeline.add("note", f"could not speak: {exc.message}")
            return
        self.stats.speeches += 1
        self.timeline.add("said", (f"(to {to}) " if to else "") + text)
        if obs.entities.players or to:
            self.identity.bump(conversations=1)
            self.drives.on_event("social")

    # ---------------------------------------------------------------------------------------
    # control surface (MCP façade, dashboard) — everything goes through the same memory/timeline
    # ---------------------------------------------------------------------------------------
    async def speak(self, text: str, to: str | None = None) -> None:
        """Say something in game on behalf of the mind (logged like any speech)."""
        obs = self.body.latest_observation or await self.body.observe("compact")
        await self._say(text, to, obs)

    def hear_mentor(self, text: str, source: str = "mentor") -> None:
        """A message from outside the game. It is advice, not a command: the next decision weighs it."""
        text = text.strip()[:1200]
        if not text:
            return
        self._mentor_inbox.append((source, text))
        self.timeline.add("mentor_in", f"{source} (outside the game): {text}", actors=[source], importance=0.6)
        self.wake(f"mentor:{source}")

    def _mentor_block(self) -> str:
        if not self._mentor_inbox:
            return ""
        lines = [f"{src} says: {txt}" for src, txt in self._mentor_inbox]
        self._mentor_inbox.clear()
        return (
            "Words from outside the game, from someone who looks after you. Weigh them like advice from a trusted friend — "
            "you still decide, and you may answer them through `speech` only if players would understand it; otherwise act, or note it.\n" + "\n".join(lines)
        )

    def _cancel_action(self, reason: str) -> None:
        if self._action_task and not self._action_task.done():
            self._action_task.cancel()
        self._action_task = None

    async def _start_action(self, name: str, args: dict[str, Any], obs: Observation) -> None:
        if self._action_task and not self._action_task.done():
            self._cancel_action("replaced")
            with contextlib.suppress(Exception):
                await self.body.stop()
        self._task_before = obs
        self._action_label = f"{name}"
        self._action_sig = signature_of("primitive", name, args)
        self.stats.actions += 1
        self.timeline.add("action", f"{name} {args}"[:200], importance=0.2)
        self._action_task = asyncio.create_task(self._run_action(name, args), name=f"action-{name}")

    async def _run_action(self, name: str, args: dict[str, Any]) -> None:
        try:
            result = await self.body.act(name, args)
        except BodyError as exc:
            self._last_result_text = f"{name} FAILED before starting: {exc.code}: {exc.message}"
            self.timeline.add("failure", self._last_result_text[:200], importance=0.5)
            self.reflection.record(self._action_sig, False, exc.code, exc.message)
            self.drives.on_event("failure")
            self.wake(f"action failed: {name}")
            return
        except asyncio.CancelledError:
            return
        await self._on_result(result, result_text=render_action_result(result))

    async def _start_skill(self, goal: str, obs: Observation) -> None:
        if self.synthesizer is None:
            self._last_result_text = "I cannot write skills right now (no code model)."
            return
        if self._action_task and not self._action_task.done():
            self._cancel_action("replaced")
            with contextlib.suppress(Exception):
                await self.body.stop()
        self._task_before = obs
        self._action_label = f"skill: {goal}"
        self._action_sig = signature_of("skill", None, goal=goal)
        self.stats.skills += 1
        self.timeline.add("action", f"working on a program to: {goal}", importance=0.3)
        self._action_task = asyncio.create_task(self._run_skill(goal, obs), name="skill")

    async def _start_construction(self, brief: str, size: tuple[int, int, int] | None, obs: Observation) -> None:
        if self.constructor is None:
            self._last_result_text = "I cannot design buildings right now (no architect)."
            return
        if self._action_task and not self._action_task.done():
            self._cancel_action("replaced")
            with contextlib.suppress(Exception):
                await self.body.stop()
        self._task_before = obs
        self._action_label = f"designing and building: {brief}"
        self._action_sig = signature_of("design", None, goal=brief)
        self.stats.actions += 1
        self.timeline.add("action", f"designing and building: {brief}"[:200], importance=0.4)

        async def run() -> None:
            try:
                outcome: ConstructionOutcome = await self.constructor.build_from_brief(brief, obs, size=size, progress=lambda m: self.timeline.add("note", m[:200], importance=0.1))  # type: ignore[union-attr]
            except asyncio.CancelledError:
                return
            except Exception as exc:  # noqa: BLE001
                self._last_result_text = f"construction crashed: {exc}"
                self.timeline.add("failure", self._last_result_text[:200])
                self.wake("construction crashed")
                return
            if outcome.ok and outcome.origin:
                ox, oy, oz = outcome.origin
                self.graph.mark_place(outcome.name, ox, oy, oz, kind="structure", notes=brief[:120])
                self.identity.bump(structures_built=1)
                self.drives.on_event("achievement")
                with contextlib.suppress(Exception):
                    await self.wiki.note("project", outcome.name[:60], f"{brief}\n\nBuilt at ({ox}, {oy}, {oz}). {outcome.summary()}", tags=["build"], salience=0.7)
            await self._on_result(outcome.build, result_text=outcome.summary())

        self._action_task = asyncio.create_task(run(), name="construction")

    async def _start_stored_skill(self, name: str, args: dict[str, Any], obs: Observation) -> None:
        """Run a skill that already exists in the library, by name — no code model involved."""
        library = self.synthesizer.library if self.synthesizer else None
        skill = library.get(name) if library else None
        if skill is None:
            self._last_result_text = f"skill {name} is not in my library"
            self.timeline.add("failure", self._last_result_text)
            return
        if self._action_task and not self._action_task.done():
            self._cancel_action("replaced")
            with contextlib.suppress(Exception):
                await self.body.stop()
        self._task_before = obs
        self._action_label = f"skill {name}"
        self._action_sig = signature_of("stored_skill", name, args)
        self.stats.skills += 1
        self.timeline.add("action", f"running my skill {name} {args}"[:200], importance=0.3)

        async def run() -> None:
            started = time.time()
            try:
                result = await self.body.run_skill(skill.name, skill.code, args)
            except BodyError as exc:
                self._last_result_text = f"skill {name} FAILED before starting: {exc.code}: {exc.message}"
                self.timeline.add("failure", self._last_result_text[:200], importance=0.5)
                self.wake(f"skill failed: {name}")
                return
            except asyncio.CancelledError:
                return
            if library is not None:
                library.record_outcome(skill.name, result.ok, (time.time() - started) * 1000)
            self.identity.bump(skills_used=1)
            await self._on_result(result, result_text=render_action_result(result))

        self._action_task = asyncio.create_task(run(), name=f"skill-{name}")

    async def _run_skill(self, goal: str, obs: Observation) -> None:
        assert self.synthesizer is not None
        try:
            outcome: SkillOutcome = await self.synthesizer.accomplish(goal, obs)
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            self._last_result_text = f"skill attempt crashed: {exc}"
            self.timeline.add("failure", self._last_result_text[:200])
            self.wake("skill crashed")
            return
        if outcome.ok and outcome.skill and not outcome.reused:
            self.identity.bump(skills_learned=1)
            self.drives.on_event("skill_learned")
            self.timeline.add("achievement", f"learned a new skill: {outcome.skill.name}", importance=0.7)
        elif outcome.ok and outcome.skill:
            self.identity.bump(skills_used=1)
        await self._on_result(outcome.result, result_text=outcome.summary())

    async def _on_result(self, result: ActionResult | SkillRunResult | None, *, result_text: str) -> None:
        self._last_result = result
        self._last_result_text = result_text
        ok = bool(result and result.ok)
        self.timeline.add("result" if ok else "failure", result_text[:300], importance=0.3 if ok else 0.5)
        self.reflection.record(self._action_sig or "?", ok, (result.errorCode if result else "") or "", (result.error if result else "") or "")
        if not ok:
            self.drives.on_event("failure")
        task = self.planner.current_task()
        if task is not None:
            after: Observation | None
            try:
                after = await self.body.observe("compact")
            except Exception:  # noqa: BLE001
                after = self.body.latest_observation
            if after is not None:
                verdict = await self.critic.verify(task, self._task_before, after, result_text, self.planner.flags)
                if verdict.success:
                    self.planner.complete_task(task)
                    self.timeline.add("achievement", f"task done: {task.description} ({verdict.reasoning[:80]})", importance=0.8)
                    self.drives.on_event("achievement")
                    if task.kind == "build":
                        self.identity.bump(structures_built=1)
                elif not ok or verdict.method == "programmatic":
                    self.planner.fail_task(task, verdict.critique or verdict.reasoning)
                    if task.status == "failed":
                        self.planner.record_milestone_failure(task)
                        self.timeline.add("failure", f"gave up on: {task.description}", importance=0.6)
        self.wake("action result")

    # ---------------------------------------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        return {
            "stats": self.stats.__dict__,
            "identity": {"name": self.identity.name, "level": self.identity.level.name, "experience": round(self.identity.metrics.experience(), 1)},
            "drives": self.drives.state.__dict__,
            "goals": self.planner.progress(),
            "last_result": self._last_result_text[:200],
            "thought": {"reason": self._last_thought, "intent": self._last_intent, "speech": self._last_speech, "at": self._last_decision_at},
            "action": self._action_label if self._action_task is not None and not self._action_task.done() else None,
            "task": (self.planner.current_task() or Task("")).description or None,
            "reflection": self.reflection.snapshot(),
            "router": self.router.health(),
        }
