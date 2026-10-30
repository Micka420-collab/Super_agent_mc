/**
 * Reflex system — the spinal cord.
 *
 * Runs on the physics tick without any LLM in the loop, as priority chains (the pattern that makes
 * AltoClef/ChatClef and mc_aiplayer survive while pure-LLM agents die): the highest-priority
 * triggered reflex preempts whatever deliberate action the mind requested, does the minimum, then
 * hands control back. Every trigger and completion is reported to the mind as a `reflex` event so
 * the deliberative layer can reason about what its body just did.
 */
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { ActionRunner, Running } from '../actions/runner.js';
import type { Observer } from '../perception/observer.js';
import { classifyEntity, EXPLOSIVE_MOBS, isThreat } from '../perception/entities.js';
import { ReflexConfigSchema, type ReflexConfig } from '../protocol.js';
import { getLogger } from '../util/logger.js';
import { distance } from '../util/geometry.js';
import { equipBestWeapon } from './items.js';
import { fleeFrom, holdControl, stopAllMovement } from './movement.js';

export type ReflexEmitter = (payload: Record<string, unknown>) => void;

export interface ReflexCandidate {
  name: string;
  priority: number;
  reason: string;
  run: (running: Running) => Promise<void>;
}

interface PvpPlugin {
  attack: (target: Entity) => Promise<void>;
  stop: () => Promise<void>;
  target?: Entity;
}

export class ReflexSystem {
  config: ReflexConfig = ReflexConfigSchema.parse({});
  private active: { name: string; priority: number; running: Running } | null = null;
  private tickCounter = 0;
  private lastAttackerId: number | null = null;
  private lastHurtAt = 0;
  private cooldowns = new Map<string, number>();
  private readonly log = getLogger('reflex');

  constructor(
    private readonly bot: Bot,
    private readonly observer: Observer,
    private readonly runner: ActionRunner,
    private readonly emit: ReflexEmitter,
  ) {}

  configure(partial: Partial<ReflexConfig>): ReflexConfig {
    this.config = ReflexConfigSchema.parse({ ...this.config, ...partial });
    this.applyAutoEat();
    return this.config;
  }

  attach(): void {
    this.applyAutoEat();
    this.bot.on('physicsTick', () => {
      this.tickCounter += 1;
      if (this.tickCounter % 2 === 0) this.tick();
    });
    this.bot.on('entityHurt', (entity, source) => {
      if (entity === this.bot.entity && source) {
        this.lastAttackerId = source.id;
        this.lastHurtAt = Date.now();
      }
    });
    this.bot.on('death', () => {
      this.lastAttackerId = null;
    });
  }

  private applyAutoEat(): void {
    const ae = (this.bot as unknown as { autoEat?: { setOpts: (o: Record<string, unknown>) => void; enableAuto: () => void; disableAuto: () => void } }).autoEat;
    if (!ae) return;
    try {
      ae.setOpts({ minHunger: this.config.eatAtFood, minHealth: 14, priority: 'foodPoints', bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'] });
      if (this.config.enabled && this.config.autoEat) ae.enableAuto();
      else ae.disableAuto();
    } catch (err) {
      this.log.warn({ err }, 'auto-eat configuration failed');
    }
  }

  /** Nearest threatening entity within range, never an ally. */
  private nearestThreat(range: number): { entity: Entity; dist: number } | null {
    const bot = this.bot;
    let best: { entity: Entity; dist: number } | null = null;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position) continue;
      const name = e.name ?? '';
      const kind = classifyEntity({ type: e.type, name, category: bot.registry.entitiesByName?.[name]?.category });
      if (kind === 'player') continue; // reflexes never fight players; the mind decides that
      const angry = this.lastAttackerId === e.id && Date.now() - this.lastHurtAt < 8_000;
      if (!isThreat(kind, name, angry)) continue;
      const d = distance(bot.entity.position, e.position);
      if (d <= range && (!best || d < best.dist)) best = { entity: e, dist: d };
    }
    return best;
  }

  private onCooldown(name: string, ms: number): boolean {
    const until = this.cooldowns.get(name) ?? 0;
    if (Date.now() < until) return true;
    this.cooldowns.set(name, Date.now() + ms);
    return false;
  }

  /** Decide which reflex (if any) should run right now. Pure w.r.t. side effects — easy to test. */
  evaluate(): ReflexCandidate | null {
    const bot = this.bot;
    const cfg = this.config;
    if (!cfg.enabled || !bot.entity || bot.health <= 0 || bot.isSleeping) return null;
    const self = bot.entity as unknown as { isInLava?: boolean; onFire?: boolean; isInWater?: boolean };
    const feet = bot.blockAt(bot.entity.position);

    // 1. Lava / fire
    if (cfg.escapeLavaAndFire && (self.isInLava || feet?.name === 'lava' || feet?.name === 'fire' || (self.onFire && bot.health < 12))) {
      return {
        name: 'escape_fire',
        priority: 90,
        reason: self.isInLava || feet?.name === 'lava' ? 'in lava' : 'on fire',
        run: async (running) => {
          const water = bot.findBlock({ matching: (b) => b.name === 'water', maxDistance: 8 });
          if (water) {
            await fleeFrom(bot, bot.entity.position, 0.1, running.controller.signal, 1).catch(() => undefined);
            await this.moveTowards(water.position, running, 6_000);
            return;
          }
          // back away from the heat: jump + move backwards
          await holdControl(bot, 'jump', 200, running.controller.signal);
          await holdControl(bot, 'back', 900, running.controller.signal);
        },
      };
    }

    // 2. Drowning
    if (cfg.surfaceWhenDrowning && bot.oxygenLevel <= cfg.drownAtOxygen && (self.isInWater || feet?.name === 'water')) {
      return {
        name: 'surface',
        priority: 85,
        reason: `oxygen ${bot.oxygenLevel}`,
        run: async (running) => {
          const deadline = Date.now() + 8_000;
          stopAllMovement(bot);
          while (Date.now() < deadline && bot.oxygenLevel < 18 && !running.controller.signal.aborted) {
            bot.setControlState('jump', true);
            await new Promise((r) => setTimeout(r, 150));
          }
          bot.setControlState('jump', false);
        },
      };
    }

    // 3. Flee when weak
    const threat = this.nearestThreat(Math.max(cfg.defendRange, 8));
    if (threat && bot.health <= cfg.fleeAtHealth) {
      return {
        name: 'flee',
        priority: 80,
        reason: `health ${bot.health} with ${threat.entity.name} at ${threat.dist.toFixed(1)}m`,
        run: async (running) => {
          await fleeFrom(bot, threat.entity.position, cfg.fleeDistance, running.controller.signal, 12_000).catch(() => undefined);
        },
      };
    }

    // 4. Creepers
    if (cfg.avoidCreepers) {
      const creeper = this.nearestThreat(cfg.creeperRange);
      if (creeper && EXPLOSIVE_MOBS.has(creeper.entity.name ?? '')) {
        return {
          name: 'avoid_creeper',
          priority: 75,
          reason: `creeper at ${creeper.dist.toFixed(1)}m`,
          run: async (running) => {
            await fleeFrom(bot, creeper.entity.position, cfg.creeperRange + 4, running.controller.signal, 6_000).catch(() => undefined);
          },
        };
      }
    }

    // 5. Defend
    if (cfg.autoDefend && threat && threat.dist <= cfg.defendRange && !EXPLOSIVE_MOBS.has(threat.entity.name ?? '')) {
      // only interrupt a deliberate action when the mob is actually hurting us or very close
      const aggressive = (this.lastAttackerId === threat.entity.id && Date.now() - this.lastHurtAt < 5_000) || threat.dist <= 3;
      if (aggressive || !this.runner.isBusy()) {
        return {
          name: 'defend',
          priority: 60,
          reason: `${threat.entity.name} at ${threat.dist.toFixed(1)}m${aggressive ? ' (attacking me)' : ''}`,
          run: async (running) => {
            const pvp = (bot as unknown as { pvp?: PvpPlugin }).pvp;
            await equipBestWeapon(bot);
            if (!pvp) {
              await bot.lookAt(threat.entity.position.offset(0, 1, 0), true);
              bot.attack(threat.entity);
              return;
            }
            void pvp.attack(threat.entity).catch(() => undefined);
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline && !running.controller.signal.aborted) {
              const e = bot.entities[threat.entity.id];
              if (!e || (e.health !== undefined && e.health <= 0) || distance(bot.entity.position, e.position) > cfg.defendRange + 6) break;
              if (bot.health <= cfg.fleeAtHealth) break;
              await new Promise((r) => setTimeout(r, 200));
            }
            await pvp.stop();
          },
        };
      }
    }
    return null;
  }

  private async moveTowards(target: { x: number; y: number; z: number }, running: Running, timeoutMs: number): Promise<void> {
    const { goTo } = await import('./movement.js');
    await goTo(this.bot, target, 1, running.controller.signal, { timeoutMs, profile: undefined }).catch(() => undefined);
  }

  private tick(): void {
    if (this.active) return; // one reflex at a time
    let candidate: ReflexCandidate | null;
    try {
      candidate = this.evaluate();
    } catch (err) {
      this.log.warn({ err }, 'reflex evaluation failed');
      return;
    }
    if (!candidate) return;
    if (this.onCooldown(candidate.name, candidate.name === 'defend' ? 500 : 1_500)) return;
    void this.fire(candidate);
  }

  private async fire(c: ReflexCandidate): Promise<void> {
    // preempt the current deliberate action if it has lower priority
    if (this.runner.isBusy()) {
      const interrupted = this.runner.interrupt(`reflex:${c.name} (${c.reason})`, c.priority);
      if (!interrupted) return; // something more important is running
      // give the interrupted action a beat to unwind
      await new Promise((r) => setTimeout(r, 60));
      if (this.runner.isBusy()) {
        // still busy (skill tearing down) — try again next tick
        return;
      }
    }
    let running: Running;
    try {
      running = this.runner.acquire(`reflex:${c.name}`, 'action', c.priority);
    } catch {
      return;
    }
    this.active = { name: c.name, priority: c.priority, running };
    this.emit({ name: c.name, phase: 'start', reason: c.reason, priority: c.priority });
    const t0 = Date.now();
    try {
      await c.run(running);
      this.emit({ name: c.name, phase: 'end', ok: true, ms: Date.now() - t0, health: this.bot.health, food: this.bot.food });
    } catch (err) {
      this.emit({ name: c.name, phase: 'end', ok: false, ms: Date.now() - t0, error: (err as Error).message });
    } finally {
      stopAllMovement(this.bot);
      this.runner.release(running);
      this.active = null;
    }
  }
}
