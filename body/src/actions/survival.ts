import { z } from 'zod';
import type { Block } from 'prismarine-block';
import { BodyError, ErrorCodes } from '../protocol.js';
import { findItem } from '../motor/items.js';
import { goToBlock } from '../motor/movement.js';
import { findPlacementSpotNear, placeBlockAt } from '../motor/placing.js';
import { raceAbort, sleep, waitFor } from '../util/async.js';
import { defineAction, type ActionContext } from './registry.js';

interface AutoEatPlugin {
  eat: (opts?: { food?: string; offhand?: boolean; equipOldItem?: boolean }) => Promise<void>;
  isEating: boolean;
  foodsByName: Record<string, { foodPoints: number; saturation: number }>;
}

defineAction({
  name: 'eat',
  category: 'survival',
  description: 'Eat food from the inventory (best available unless a name is given).',
  longRunning: true,
  schema: z.object({ name: z.string().optional() }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const before = { food: bot.food, saturation: bot.foodSaturation };
    if (bot.food >= 20 && !a.name) return { ate: null, reason: 'not hungry', ...before };
    const ae = (bot as unknown as { autoEat?: AutoEatPlugin }).autoEat;
    if (ae) {
      await raceAbort(ae.eat(a.name ? { food: a.name, equipOldItem: true } : { equipOldItem: true }), ctx.signal, { timeoutMs: 8_000 });
    } else {
      const foods = bot.registry.foodsByName;
      const item = a.name ? findItem(bot, a.name) : bot.inventory.items().filter((i) => foods[i.name]).sort((x, y) => (foods[y.name]?.foodPoints ?? 0) - (foods[x.name]?.foodPoints ?? 0))[0];
      if (!item) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no food in inventory');
      await bot.equip(item, 'hand');
      await raceAbort(bot.consume(), ctx.signal, { timeoutMs: 8_000 });
    }
    await sleep(200, ctx.signal);
    return { ate: a.name ?? 'best food', before, after: { food: bot.food, saturation: bot.foodSaturation } };
  },
});

export function findBed(ctx: ActionContext, maxDistance = 32): Block | null {
  const bot = ctx.bot;
  return bot.findBlock({ matching: (b) => b.name.endsWith('_bed'), maxDistance });
}

defineAction({
  name: 'sleep',
  category: 'survival',
  description:
    'Sleep in a bed (finds one nearby or places one from the inventory). Only works at night / during storms. Triggers the mind\'s dream/consolidation cycle.',
  longRunning: true,
  schema: z.object({ maxDistance: z.number().min(1).max(64).default(32), waitForMorning: z.boolean().default(false) }),
  async run(ctx, a) {
    const bot = ctx.bot;
    if (bot.isSleeping) return { sleeping: true, reason: 'already sleeping' };
    let bed = findBed(ctx, a.maxDistance);
    if (!bed) {
      const bedItem = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
      if (!bedItem) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no bed nearby and none in inventory (craft: 3 wool + 3 planks)');
      const spot = findPlacementSpotNear(bot, 3);
      if (!spot) throw new BodyError(ErrorCodes.NOT_FOUND, 'no room to place a bed');
      await placeBlockAt(bot, bedItem.name, spot, ctx.signal);
      bed = findBed(ctx, 6);
      if (!bed) throw new BodyError(ErrorCodes.INTERNAL, 'bed placement failed');
    }
    await goToBlock(bot, bed.position, ctx.signal);
    try {
      await raceAbort(bot.sleep(bed), ctx.signal, { timeoutMs: 8_000 });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      throw new BodyError(ErrorCodes.BAD_REQUEST, `cannot sleep: ${msg}`);
    }
    if (a.waitForMorning) {
      await waitFor(() => !bot.isSleeping, { timeoutMs: 10 * 60_000, intervalMs: 500, signal: ctx.signal, message: 'still asleep' });
    }
    return { sleeping: bot.isSleeping, bed: { x: bed.position.x, y: bed.position.y, z: bed.position.z } };
  },
});

defineAction({
  name: 'wake',
  category: 'survival',
  description: 'Get out of bed.',
  longRunning: false,
  schema: z.object({}),
  async run(ctx) {
    if (!ctx.bot.isSleeping) return { sleeping: false };
    await raceAbort(ctx.bot.wake(), ctx.signal, { timeoutMs: 5_000 });
    return { sleeping: ctx.bot.isSleeping };
  },
});

defineAction({
  name: 'respawn',
  category: 'survival',
  description: 'Respawn after death.',
  longRunning: false,
  schema: z.object({}),
  async run(ctx) {
    if (ctx.bot.health > 0) return { respawned: false, reason: 'not dead' };
    ctx.bot.respawn();
    await sleep(500, ctx.signal);
    return { respawned: true };
  },
});
