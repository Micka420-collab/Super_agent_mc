/**
 * Bot factory — creates the Mineflayer bot, loads plugins, wires world events into the bridge.
 */
import mineflayer, { type Bot, type BotOptions } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock';
import { loader as autoEatPlugin } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import { plugin as toolPlugin } from 'mineflayer-tool';
import type { BodyConfig } from './config.js';
import { ActivityWatcher, describeEpisode } from './perception/activity.js';
import { Observer, droppedItemOf } from './perception/observer.js';
import { buildMovements, stopAllMovement } from './motor/movement.js';
import { ActionRunner } from './actions/runner.js';
import { ReflexSystem } from './motor/reflexes.js';
import { classifyEntity } from './perception/entities.js';
import type { EventName } from './protocol.js';
import { getLogger } from './util/logger.js';
import { distance, roundVec } from './util/geometry.js';

/** The vanilla 0.3, plus the margin the server needs to accept a position against a wall. */
export const PLAYER_HALF_WIDTH = 0.3001;

const { pathfinder } = pathfinderPkg;

export interface BodyRuntime {
  bot: Bot;
  observer: Observer;
  runner: ActionRunner;
  reflexes: ReflexSystem;
  /** Register a listener for world events destined to the mind. */
  onEvent: (fn: (event: EventName, payload: unknown) => void) => void;
}

export function botOptions(config: BodyConfig): BotOptions {
  const opts: BotOptions = {
    host: config.MC_HOST,
    port: config.MC_PORT,
    username: config.MC_USERNAME,
    // a real player respawns when it decides to — the mind triggers `respawn`
    respawn: false,
    hideErrors: false,
    checkTimeoutInterval: 60_000,
  };
  if (config.MC_VERSION) opts.version = config.MC_VERSION;
  if (config.MC_AUTH === 'microsoft') opts.auth = 'microsoft';
  return opts;
}

export function createBody(config: BodyConfig): BodyRuntime {
  const log = getLogger('bot');
  const bot = mineflayer.createBot(botOptions(config));
  const listeners = new Set<(event: EventName, payload: unknown) => void>();
  const emit = (event: EventName, payload: unknown) => {
    for (const fn of listeners) {
      try {
        fn(event, payload);
      } catch (err) {
        log.error({ err }, 'event listener failed');
      }
    }
  };

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);
  bot.loadPlugin(collectBlockPlugin);
  bot.loadPlugin(toolPlugin);
  bot.loadPlugin(autoEatPlugin);
  bot.loadPlugin(armorManager);
  // Paper 1.21.11 refuses a position flush against a wall: prismarine-physics puts the hitbox exactly on the block
  // face and the server sends us back every tick (~18 corrections/s, frozen physics, digs 5× slower, walks that never
  // leave a wall or a tree top). A 0.0001 margin is enough: measured 85-95 corrections in 5 s against a wall → 0
  bot.once('login', () => {
    const physics = (bot as unknown as { physics?: { playerHalfWidth: number } }).physics;
    if (physics) physics.playerHalfWidth = PLAYER_HALF_WIDTH;
  });

  const observer = new Observer(bot, {
    honestPerception: config.MC_HONEST_PERCEPTION,
    perceptionRadius: config.MC_PERCEPTION_RADIUS,
    fovDeg: config.MC_FOV_DEG,
    chatBufferSize: 20,
    eventBufferSize: 30,
  });
  observer.attach();
  const runner = new ActionRunner(bot, observer);
  const reflexes = new ReflexSystem(bot, observer, runner, (payload) => {
    observer.pushEvent('reflex', `${payload['name']} ${payload['phase']}${payload['reason'] ? `: ${payload['reason']}` : ''}`);
    emit('reflex', payload);
  });
  reflexes.configure({ enabled: config.REFLEX_ENABLED });

  runner.on('interrupted', (p) => emit('action.interrupted', p));
  runner.on('progress', (p) => observer.pushEvent('progress', `${p.action}: ${p.message}`));

  // ---- World events -------------------------------------------------------------------------
  let lastPhase: string | null = null;
  let lastHealth = 20;

  bot.once('spawn', () => {
    bot.pathfinder.setMovements(buildMovements(bot));
    reflexes.attach();
    log.info({ username: bot.username, version: bot.version, position: roundVec(bot.entity.position) }, 'spawned');
    observer.pushEvent('spawn', `spawned at ${JSON.stringify(roundVec(bot.entity.position))}`);
    lastHealth = bot.health;
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    emit('chat', { from: username, text: message, ts: Date.now() });
  });
  bot.on('whisper', (username, message) => {
    emit('whisper', { from: username, text: message, ts: Date.now() });
  });
  bot.on('health', () => {
    const delta = bot.health - lastHealth;
    if (delta < -0.5) {
      observer.pushEvent('hurt', `took ${Math.abs(delta).toFixed(1)} damage (health ${bot.health.toFixed(1)})`);
    }
    lastHealth = bot.health;
    emit('health', { health: bot.health, food: bot.food, saturation: bot.foodSaturation, delta });
  });
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) return;
    const src = source ? observer.describeEntity(source) : null;
    emit('hurt', { health: bot.health, source: src });
  });
  bot.on('death', () => {
    // nothing the body was doing survives a death: release the hands and the keys
    runner.interrupt('died', Number.POSITIVE_INFINITY);
    stopAllMovement(bot);
    observer.pushEvent('death', 'I died');
    emit('death', { position: bot.entity ? roundVec(bot.entity.position) : null, ts: Date.now() });
  });
  bot.on('respawn', () => {
    observer.pushEvent('respawn', 'respawned');
    emit('respawn', { position: bot.entity ? roundVec(bot.entity.position) : null });
  });
  bot.on('entitySpawn', (entity) => {
    if (!bot.entity || !entity.position) return;
    const name = entity.name ?? '';
    const kind = classifyEntity({ type: entity.type, name, category: bot.registry.entitiesByName?.[name]?.category });
    if (kind !== 'player' && kind !== 'hostile') return;
    const d = distance(bot.entity.position, entity.position);
    if (d > 24) return;
    const view = observer.describeEntity(entity, d);
    observer.pushEvent('entity.spawn', `${view.username ?? view.name} appeared ${view.distance}m ${view.relative}`);
    emit('entity.spawn', view);
  });
  bot.on('entityGone', (entity) => {
    if (entity.type !== 'player') return;
    emit('entity.gone', { id: entity.id, username: entity.username, name: entity.name });
  });
  // the server moved us (teleport or anti-cheat correction): mineflayer then zeroes the velocity and onGround, which
  // also makes the next dig 5× slower — worth seeing in the logs when it happens repeatedly
  let forced = 0;
  let forcedSince = Date.now();
  let burst: number[] = [];
  bot.on('forcedMove', () => {
    forced += 1;
    // fighting the server: more than 10 corrections in a second means the pathfinder (or a held key) keeps asking for
    // a move the server refuses. Stop steering, or physics stays frozen (onGround false, digs five times slower)
    const now = Date.now();
    burst = burst.filter((t) => now - t < 1_000);
    burst.push(now);
    if (burst.length > 10) {
      burst = [];
      // only a goal left over from a finished action is cut: halting a live walk aborted crafts ("goal changed") and
      // did not stop the corrections either (seen live: 20 per second with no goal and no key held)
      if (!runner.isBusy()) {
        stopAllMovement(bot);
        log.warn({ position: bot.entity.position }, 'the server rejects my moves: stopped a leftover walk');
      }
    }
    if (Date.now() - forcedSince >= 10_000) {
      if (forced >= 3) {
        const pf = (bot as unknown as { pathfinder?: { isMoving?: () => boolean; isMining?: () => boolean; goal?: { constructor?: { name?: string } } | null } }).pathfinder;
        const controls = Object.entries(bot.controlState).filter(([, on]) => on).map(([k]) => k);
        log.warn({ corrections: forced, position: bot.entity.position, pathfinding: pf?.isMoving?.() ?? false, mining: pf?.isMining?.() ?? false, goal: pf?.goal?.constructor?.name ?? null, controls, digging: !!(bot as unknown as { targetDigBlock?: unknown }).targetDigBlock }, 'server keeps correcting my position');
      }
      forced = 0;
      forcedSince = Date.now();
    }
  });
  bot.on('playerJoined', (player) => {
    if (player.username === bot.username) return;
    observer.pushEvent('player.joined', `${player.username} joined the server`);
    emit('player.joined', { username: player.username });
  });
  bot.on('playerLeft', (player) => {
    observer.pushEvent('player.left', `${player.username} left the server`);
    emit('player.left', { username: player.username });
  });
  bot.on('playerCollect', (collector, collected) => {
    if (collector !== bot.entity) return;
    const item = droppedItemOf(collected);
    if (item) {
      observer.pushEvent('item.collected', `picked up ${item.count} ${item.name}`);
      emit('item.collected', { name: item.name, count: item.count });
    }
  });
  bot.on('diggingCompleted', (block) => {
    emit('block.broken', { name: block.name, position: block.position });
  });
  // other players at work: attributed block changes, aggregated into episodes worth remembering
  const activity = new ActivityWatcher((episode) => {
    observer.pushEvent('player.activity', describeEpisode(episode));
    emit('player.activity', { ...episode, text: describeEpisode(episode) });
  });
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!oldBlock || !newBlock || !bot.entity) return;
    const others = Object.values(bot.players)
      .filter((p) => p.entity && p.username !== bot.username)
      .map((p) => ({ username: p.username, position: p.entity.position }));
    if (!others.length) return;
    activity.onBlockChange(newBlock.position, oldBlock.name, newBlock.name, others, { position: bot.entity.position, busy: runner.isBusy() });
  });
  const activityTimer = setInterval(() => activity.tick(), 1_000);
  bot.once('end', () => clearInterval(activityTimer));
  bot.on('sleep', () => {
    observer.pushEvent('sleep', 'fell asleep');
    emit('sleep', { timeOfDay: bot.time.timeOfDay, day: bot.time.day });
  });
  bot.on('wake', () => {
    observer.pushEvent('wake', 'woke up');
    emit('wake', { timeOfDay: bot.time.timeOfDay, day: bot.time.day });
  });
  bot.on('time', () => {
    const t = bot.time.timeOfDay;
    const phase = t < 1000 || t >= 23000 ? 'dawn' : t < 12000 ? 'day' : t < 13000 ? 'dusk' : 'night';
    if (lastPhase && phase !== lastPhase) {
      if (phase === 'dawn') {
        observer.pushEvent('daybreak', `day ${bot.time.day} begins`);
        emit('daybreak', { day: bot.time.day });
      } else if (phase === 'dusk') {
        observer.pushEvent('nightfall', 'night is falling');
        emit('nightfall', { day: bot.time.day });
      }
    }
    lastPhase = phase;
  });
  bot.on('rain', () => emit('rain', { raining: bot.isRaining, thunder: bot.thunderState > 0 }));
  bot.on('kicked', (reason, loggedIn) => {
    log.warn({ reason, loggedIn }, 'kicked');
    emit('kicked', { reason: String(reason), loggedIn });
  });
  bot.on('end', (reason) => {
    log.warn({ reason }, 'disconnected');
    emit('disconnected', { reason });
  });
  bot.on('error', (err) => {
    log.error({ err }, 'bot error');
    emit('error', { message: err.message });
  });

  return {
    bot,
    observer,
    runner,
    reflexes,
    onEvent: (fn) => listeners.add(fn),
  };
}
