import { z } from 'zod';
import { Vec3 } from 'vec3';
import type { Block } from 'prismarine-block';
import { BodyError, ErrorCodes } from '../protocol.js';
import { goToBlock } from '../motor/movement.js';
import { equipByName, findItem, inventorySummary, resolveItemNames } from '../motor/items.js';
import { raceAbort, sleep } from '../util/async.js';
import { toItemStack } from '../perception/observer.js';
import { inventoryDelta } from './mining.js';
import { defineAction, type ActionContext } from './registry.js';

const CONTAINER_NAMES = ['chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box'];

function containerAt(ctx: ActionContext, pos: { x: number; y: number; z: number }): Block {
  const block = ctx.bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
  if (!block || !(CONTAINER_NAMES.includes(block.name) || block.name.endsWith('shulker_box'))) {
    throw new BodyError(ErrorCodes.NOT_FOUND, `no container at ${pos.x},${pos.y},${pos.z} (found ${block?.name ?? 'nothing'})`);
  }
  return block;
}

const PosSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });

defineAction({
  name: 'inventory',
  category: 'inventory',
  description: 'List inventory contents (aggregated by item).',
  longRunning: false,
  schema: z.object({}),
  async run(ctx) {
    return { items: inventorySummary(ctx.bot), freeSlots: ctx.bot.inventory.emptySlotCount(), held: toItemStack(ctx.bot.heldItem) };
  },
});

defineAction({
  name: 'equip',
  category: 'inventory',
  description: 'Equip an item in a slot: hand, off-hand, head, torso, legs, feet.',
  longRunning: false,
  schema: z.object({ name: z.string(), destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']).default('hand') }),
  async run(ctx, a) {
    const item = await raceAbort(equipByName(ctx.bot, a.name, a.destination), ctx.signal, { timeoutMs: 5_000 });
    return { equipped: item.name, destination: a.destination };
  },
});

defineAction({
  name: 'unequip',
  category: 'inventory',
  description: 'Remove whatever is in a slot.',
  longRunning: false,
  schema: z.object({ destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']) }),
  async run(ctx, a) {
    await raceAbort(ctx.bot.unequip(a.destination), ctx.signal, { timeoutMs: 5_000 });
    return { unequipped: a.destination };
  },
});

defineAction({
  name: 'toss',
  category: 'inventory',
  description: 'Drop items on the ground (e.g. to give them to a nearby player).',
  longRunning: false,
  schema: z.object({ name: z.string(), count: z.number().int().min(1).max(2304).optional().describe('omit to drop everything of that item') }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const item = findItem(bot, a.name);
    if (!item) throw new BodyError(ErrorCodes.MISSING_ITEM, `I don't have any ${a.name}`);
    const before = inventorySummary(bot);
    const names = new Set(resolveItemNames(bot, a.name));
    const total = bot.inventory.items().filter((i) => names.has(i.name)).reduce((s, i) => s + i.count, 0);
    const count = Math.min(a.count ?? total, total);
    await raceAbort(bot.toss(item.type, null, count), ctx.signal, { timeoutMs: 5_000 });
    await sleep(100, ctx.signal);
    return { tossed: item.name, count, inventoryDelta: inventoryDelta(before, inventorySummary(bot)) };
  },
});

defineAction({
  name: 'container_view',
  category: 'inventory',
  description: 'Open a chest/barrel and list its contents.',
  longRunning: true,
  schema: PosSchema,
  async run(ctx, a) {
    const bot = ctx.bot;
    const block = containerAt(ctx, a);
    await goToBlock(bot, block.position, ctx.signal);
    const win = await raceAbort(bot.openContainer(block), ctx.signal, { timeoutMs: 10_000 });
    try {
      const items = win.containerItems().map((i) => ({ name: i.name, count: i.count, slot: i.slot }));
      return { container: block.name, position: a, items, slots: win.inventoryStart };
    } finally {
      win.close();
    }
  },
});

defineAction({
  name: 'container_deposit',
  category: 'inventory',
  description: 'Put items from the inventory into a container.',
  longRunning: true,
  schema: PosSchema.extend({ items: z.array(z.object({ name: z.string(), count: z.number().int().min(1).optional() })).min(1) }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const block = containerAt(ctx, a);
    await goToBlock(bot, block.position, ctx.signal);
    const before = inventorySummary(bot);
    const win = await raceAbort(bot.openContainer(block), ctx.signal, { timeoutMs: 10_000 });
    const results: { name: string; deposited: number; error?: string }[] = [];
    try {
      for (const want of a.items) {
        const names = new Set(resolveItemNames(bot, want.name));
        const stacks = bot.inventory.items().filter((i) => names.has(i.name));
        const total = stacks.reduce((s, i) => s + i.count, 0);
        const count = Math.min(want.count ?? total, total);
        const first = stacks[0];
        if (!first || count === 0) {
          results.push({ name: want.name, deposited: 0, error: 'not in inventory' });
          continue;
        }
        try {
          await raceAbort(win.deposit(first.type, null, count), ctx.signal, { timeoutMs: 10_000 });
          results.push({ name: first.name, deposited: count });
        } catch (err) {
          results.push({ name: first.name, deposited: 0, error: (err as Error).message });
        }
      }
    } finally {
      win.close();
    }
    return { container: block.name, position: a, results, inventoryDelta: inventoryDelta(before, inventorySummary(bot)) };
  },
});

defineAction({
  name: 'container_withdraw',
  category: 'inventory',
  description: 'Take items out of a container.',
  longRunning: true,
  schema: PosSchema.extend({ items: z.array(z.object({ name: z.string(), count: z.number().int().min(1).optional() })).min(1) }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const block = containerAt(ctx, a);
    await goToBlock(bot, block.position, ctx.signal);
    const before = inventorySummary(bot);
    const win = await raceAbort(bot.openContainer(block), ctx.signal, { timeoutMs: 10_000 });
    const results: { name: string; withdrawn: number; error?: string }[] = [];
    try {
      for (const want of a.items) {
        const names = new Set(resolveItemNames(bot, want.name));
        const stacks = win.containerItems().filter((i) => names.has(i.name));
        const total = stacks.reduce((s, i) => s + i.count, 0);
        const count = Math.min(want.count ?? total, total);
        const first = stacks[0];
        if (!first || count === 0) {
          results.push({ name: want.name, withdrawn: 0, error: 'not in container' });
          continue;
        }
        try {
          await raceAbort(win.withdraw(first.type, null, count), ctx.signal, { timeoutMs: 10_000 });
          results.push({ name: first.name, withdrawn: count });
        } catch (err) {
          results.push({ name: first.name, withdrawn: 0, error: (err as Error).message });
        }
      }
    } finally {
      win.close();
    }
    return { container: block.name, position: a, results, inventoryDelta: inventoryDelta(before, inventorySummary(bot)) };
  },
});

defineAction({
  name: 'use_item',
  category: 'inventory',
  description: 'Use the held item (right click in the air): throw an ender pearl, drink a potion, eat, light a firework...',
  longRunning: false,
  schema: z.object({ name: z.string().optional().describe('equip this item first'), offhand: z.boolean().default(false), holdMs: z.number().int().min(0).max(5000).default(0) }),
  async run(ctx, a) {
    const bot = ctx.bot;
    if (a.name) await equipByName(bot, a.name, a.offhand ? 'off-hand' : 'hand');
    bot.activateItem(a.offhand);
    if (a.holdMs > 0) {
      await sleep(a.holdMs, ctx.signal);
      bot.deactivateItem();
    }
    return { used: a.offhand ? bot.inventory.slots[45]?.name : bot.heldItem?.name };
  },
});

defineAction({
  name: 'use_block',
  category: 'inventory',
  description: 'Right-click a block (open a door, press a button, use a bed/lever, interact with a workstation).',
  longRunning: true,
  schema: PosSchema.extend({ name: z.string().optional().describe('item to hold while using (e.g. "flint_and_steel", "water_bucket")') }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const block = bot.blockAt(new Vec3(a.x, a.y, a.z));
    if (!block) throw new BodyError(ErrorCodes.NOT_FOUND, 'no block there');
    await goToBlock(bot, block.position, ctx.signal);
    if (a.name) await equipByName(bot, a.name, 'hand');
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await raceAbort(bot.activateBlock(block), ctx.signal, { timeoutMs: 5_000 });
    return { used: block.name, position: a };
  },
});

defineAction({
  name: 'use_entity',
  category: 'inventory',
  description: 'Right-click an entity (trade with a villager, shear a sheep, mount a horse, feed an animal).',
  longRunning: true,
  schema: z.object({ id: z.number().int(), name: z.string().optional().describe('item to hold first') }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const e = bot.entities[a.id];
    if (!e) throw new BodyError(ErrorCodes.NOT_FOUND, `entity ${a.id} not found`);
    const { approachEntity } = await import('../motor/movement.js');
    await approachEntity(bot, e, 3, ctx.signal, 30_000);
    if (a.name) await equipByName(bot, a.name, 'hand');
    await bot.lookAt(e.position.offset(0, (e as unknown as { height?: number }).height ?? 1, 0), true);
    await raceAbort(bot.activateEntity(e), ctx.signal, { timeoutMs: 5_000 });
    return { used: e.name, id: e.id };
  },
});
