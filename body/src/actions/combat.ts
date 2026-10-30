import { z } from 'zod';
import type { Entity } from 'prismarine-entity';
import { BodyError, ErrorCodes } from '../protocol.js';
import { equipBestWeapon } from '../motor/items.js';
import { fleeFrom } from '../motor/movement.js';
import { raceAbort, sleep, waitFor } from '../util/async.js';
import { distance } from '../util/geometry.js';
import { EntitySelectorSchema, resolveEntity } from './movement.js';
import { defineAction, type ActionContext } from './registry.js';

interface PvpPlugin {
  attack: (target: Entity) => Promise<void>;
  stop: () => Promise<void>;
  forceStop: () => void;
  target?: Entity;
  attackRange: number;
  followRange: number;
}

function pvp(ctx: ActionContext): PvpPlugin {
  const p = (ctx.bot as unknown as { pvp?: PvpPlugin }).pvp;
  if (!p) throw new BodyError(ErrorCodes.INTERNAL, 'pvp plugin not loaded');
  return p;
}

defineAction({
  name: 'attack',
  category: 'combat',
  description: 'Fight an entity until it dies, flees out of range, or the timeout expires. Equips the best weapon first.',
  longRunning: true,
  schema: EntitySelectorSchema.extend({
    timeoutMs: z.number().int().positive().max(300_000).default(60_000),
    /** Keep attacking even if health drops low (default false: the reflex layer may abort). */
    reckless: z.boolean().default(false),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const target = resolveEntity(ctx, a, 48);
    if (target.type === 'player' && ctx.observer && !a.reckless) {
      ctx.log.warn({ target: target.username }, 'attacking a player');
    }
    await equipBestWeapon(bot);
    const p = pvp(ctx);
    const startHealth = target.health;
    void p.attack(target).catch(() => undefined);
    try {
      await waitFor(
        () => !bot.entities[target.id] || (target.health !== undefined && target.health <= 0) || distance(bot.entity.position, target.position) > 40,
        { timeoutMs: a.timeoutMs, intervalMs: 100, signal: ctx.signal, message: 'the fight took too long' },
      );
    } finally {
      await p.stop();
    }
    const gone = !bot.entities[target.id];
    await sleep(400, ctx.signal);
    return { target: target.name, username: target.username, killed: gone, startHealth, endHealth: target.health };
  },
});

defineAction({
  name: 'flee',
  category: 'combat',
  description: 'Run away from an entity or position until at least `distance` blocks away.',
  longRunning: true,
  schema: z.object({
    fromId: z.number().int().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    distance: z.number().min(4).max(64).default(16),
    timeoutMs: z.number().int().positive().max(120_000).default(20_000),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    let threat: { x: number; y: number; z: number };
    if (a.fromId !== undefined) {
      const e = bot.entities[a.fromId];
      if (!e) throw new BodyError(ErrorCodes.NOT_FOUND, `entity ${a.fromId} not found`);
      threat = e.position;
    } else if (a.x !== undefined && a.y !== undefined && a.z !== undefined) {
      threat = { x: a.x, y: a.y, z: a.z };
    } else {
      // nearest hostile
      const e = ctx.observer.observe('compact').entities.hostiles[0];
      if (!e) return { fled: false, reason: 'no threat around' };
      threat = e.position;
    }
    await fleeFrom(bot, threat, a.distance, ctx.signal, a.timeoutMs);
    return { fled: true, distance: Math.round(distance(bot.entity.position, threat)) };
  },
});

defineAction({
  name: 'shield',
  category: 'combat',
  description: 'Raise (or lower) the shield in the off-hand.',
  longRunning: false,
  schema: z.object({ up: z.boolean() }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const shield = bot.inventory.items().find((i) => i.name === 'shield');
    if (!shield) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no shield');
    if (bot.inventory.slots[45]?.name !== 'shield') await raceAbort(bot.equip(shield, 'off-hand'), ctx.signal, { timeoutMs: 5_000 });
    if (a.up) bot.activateItem(true);
    else bot.deactivateItem();
    return { shield: a.up ? 'up' : 'down' };
  },
});
