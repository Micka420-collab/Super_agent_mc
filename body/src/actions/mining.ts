import { z } from 'zod';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { BodyError, ErrorCodes } from '../protocol.js';
import { goToBlock } from '../motor/movement.js';
import { equipBestTool, inventorySummary, resolveBlockNames, type ItemSummary } from '../motor/items.js';
import { raceAbort, sleep, throwIfAborted } from '../util/async.js';
import { distance } from '../util/geometry.js';
import { defineAction, type ActionContext } from './registry.js';

export function inventoryDelta(before: ItemSummary[], after: ItemSummary[]): Record<string, number> {
  const delta: Record<string, number> = {};
  const b = new Map(before.map((i) => [i.name, i.count]));
  const a = new Map(after.map((i) => [i.name, i.count]));
  for (const name of new Set([...b.keys(), ...a.keys()])) {
    const d = (a.get(name) ?? 0) - (b.get(name) ?? 0);
    if (d !== 0) delta[name] = d;
  }
  return delta;
}

/** Can the bot's inventory harvest this block (drops items)? */
export function canHarvest(ctx: ActionContext, block: Block): { ok: boolean; needed?: string[] } {
  const bot = ctx.bot;
  const def = bot.registry.blocksByName[block.name];
  const harvest = (def as unknown as { harvestTools?: Record<string, boolean> } | undefined)?.harvestTools;
  if (!harvest) return { ok: true }; // any tool / hand works
  const ids = Object.keys(harvest).map(Number);
  const have = bot.inventory.items().some((i) => ids.includes(i.type));
  if (have) return { ok: true };
  return { ok: false, needed: ids.map((id) => bot.registry.items[id]?.name ?? String(id)) };
}

async function digBlock(ctx: ActionContext, block: Block): Promise<void> {
  const bot = ctx.bot;
  await goToBlock(bot, block.position, ctx.signal);
  throwIfAborted(ctx.signal);
  await equipBestTool(bot, block);
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  await raceAbort(bot.dig(block, true), ctx.signal, { timeoutMs: 30_000, onCancel: () => bot.stopDigging() });
}

defineAction({
  name: 'mine',
  category: 'mining',
  description:
    'Find and mine blocks by name (fuzzy: "log" matches every log type), collecting the drops. Fails with MISSING_TOOL when a better pickaxe is required.',
  longRunning: true,
  schema: z.object({
    name: z.string().describe('block name, e.g. "oak_log", "iron_ore", "stone"'),
    count: z.number().int().min(1).max(256).default(1),
    maxDistance: z.number().min(1).max(128).default(32),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const names = resolveBlockNames(bot, a.name);
    if (!names.length) throw new BodyError(ErrorCodes.NOT_FOUND, `unknown block: ${a.name}`);
    const nameSet = new Set(names);
    const positions = bot.findBlocks({ matching: (b) => nameSet.has(b.name), maxDistance: a.maxDistance, count: Math.max(a.count * 4, 16) });
    if (!positions.length) throw new BodyError(ErrorCodes.NOT_FOUND, `no ${a.name} within ${a.maxDistance} blocks — explore first`);
    const blocks = positions
      .map((p) => bot.blockAt(p))
      .filter((b): b is Block => !!b)
      .sort((x, y) => distance(bot.entity.position, x.position) - distance(bot.entity.position, y.position));
    const first = blocks[0] as Block;
    const harvest = canHarvest(ctx, first);
    if (!harvest.ok) throw new BodyError(ErrorCodes.MISSING_TOOL, `mining ${first.name} requires one of: ${harvest.needed?.join(', ')}`, { needed: harvest.needed });

    const before = inventorySummary(bot);
    const collect = (bot as unknown as { collectBlock?: { collect: (t: Block[] | Block, o?: { ignoreNoPath?: boolean; count?: number }) => Promise<void> } }).collectBlock;
    let mined = 0;
    const targets = blocks.slice(0, a.count);
    if (collect) {
      await raceAbort(collect.collect(targets, { ignoreNoPath: true }), ctx.signal, {
        timeoutMs: 20_000 + 15_000 * targets.length,
        onCancel: () => {
          bot.pathfinder.stop();
          bot.stopDigging();
        },
      });
      mined = targets.length;
    } else {
      for (const b of targets) {
        throwIfAborted(ctx.signal);
        await digBlock(ctx, b);
        mined += 1;
        ctx.progress(`mined ${mined}/${a.count} ${a.name}`);
      }
    }
    // let drops reach the inventory
    await sleep(600, ctx.signal);
    const delta = inventoryDelta(before, inventorySummary(bot));
    return { requested: a.count, mined, inventoryDelta: delta };
  },
});

defineAction({
  name: 'dig',
  category: 'mining',
  description: 'Break the block at exact coordinates (walks there first).',
  longRunning: true,
  schema: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), collect: z.boolean().default(true) }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const block = bot.blockAt(new Vec3(a.x, a.y, a.z));
    if (!block || block.name === 'air') throw new BodyError(ErrorCodes.NOT_FOUND, 'nothing to dig there');
    if (!bot.canDigBlock(block) && block.hardness === -1) throw new BodyError(ErrorCodes.BAD_REQUEST, `${block.name} cannot be broken`);
    const before = inventorySummary(bot);
    await digBlock(ctx, block);
    if (a.collect) {
      await sleep(400, ctx.signal);
      // step onto the spot to pick up the drop if it is reachable
      try {
        await goToBlock(bot, block.position, ctx.signal, 8_000);
      } catch {
        /* best effort */
      }
      await sleep(300, ctx.signal);
    }
    return { broke: block.name, inventoryDelta: inventoryDelta(before, inventorySummary(bot)) };
  },
});

defineAction({
  name: 'collect_items',
  category: 'mining',
  description: 'Walk over dropped items nearby to pick them up.',
  longRunning: true,
  schema: z.object({ radius: z.number().min(1).max(32).default(10), maxItems: z.number().int().min(1).max(50).default(10) }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const before = inventorySummary(bot);
    let picked = 0;
    for (let i = 0; i < a.maxItems; i++) {
      throwIfAborted(ctx.signal);
      const item = bot.nearestEntity((e) => e.name === 'item' && distance(e.position, bot.entity.position) <= a.radius);
      if (!item) break;
      try {
        await goToBlock(bot, item.position.floored(), ctx.signal, 15_000);
        await sleep(250, ctx.signal);
        picked += 1;
      } catch (err) {
        if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
        break;
      }
    }
    return { approached: picked, inventoryDelta: inventoryDelta(before, inventorySummary(bot)) };
  },
});
