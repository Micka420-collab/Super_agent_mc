import { z } from 'zod';
import { Vec3 } from 'vec3';
import { BodyError, ErrorCodes } from '../protocol.js';
import { placeBlockAt, isReplaceable } from '../motor/placing.js';
import { countItem, inventorySummary, normalizeName } from '../motor/items.js';
import { throwIfAborted } from '../util/async.js';
import { distance } from '../util/geometry.js';
import { inventoryDelta } from './mining.js';
import { defineAction } from './registry.js';

export const BlockPlacementSchema = z.object({
  name: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});
export type BlockPlacement = z.infer<typeof BlockPlacementSchema>;

/**
 * Order placements so the structure is buildable: lowest layer first, then nearest-first within a
 * layer so the bot sweeps across instead of zig-zagging. Pure function (unit-tested).
 */
export function orderPlacements(blocks: BlockPlacement[], from: { x: number; y: number; z: number }): BlockPlacement[] {
  return [...blocks].sort((a, b) => a.y - b.y || distance(from, a) - distance(from, b));
}

/** Count how many of each block a plan needs. */
export function billOfMaterials(blocks: BlockPlacement[]): Record<string, number> {
  const bom: Record<string, number> = {};
  for (const b of blocks) bom[normalizeName(b.name)] = (bom[normalizeName(b.name)] ?? 0) + 1;
  return bom;
}

defineAction({
  name: 'place',
  category: 'building',
  description: 'Place one block from the inventory at exact coordinates (walks into position, finds a face to click, verifies).',
  longRunning: true,
  schema: BlockPlacementSchema,
  async run(ctx, a) {
    const res = await placeBlockAt(ctx.bot, a.name, a, ctx.signal);
    if (!res.placed && res.reason !== 'already there') throw new BodyError(ErrorCodes.INTERNAL, `could not place ${a.name}: ${res.reason}`);
    return res;
  },
});

defineAction({
  name: 'build',
  category: 'building',
  description:
    'Place many blocks (a structure). Checks materials first (fails with MISSING_ITEM and the bill of materials), builds bottom-up, skips cells already correct, reports failures per block.',
  longRunning: true,
  schema: z.object({
    blocks: z.array(BlockPlacementSchema).min(1).max(4096),
    /** Stop at the first failure instead of continuing. */
    strict: z.boolean().default(false),
    /** Continue even when some materials are missing (place what we can). */
    partial: z.boolean().default(false),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    // 1) skip cells that are already right
    const todo = a.blocks.filter((b) => {
      const existing = bot.blockAt(new Vec3(b.x, b.y, b.z));
      return !(existing && existing.name === normalizeName(b.name));
    });
    // 2) materials check
    const bom = billOfMaterials(todo);
    const missing: Record<string, number> = {};
    for (const [name, need] of Object.entries(bom)) {
      const have = countItem(bot, name);
      if (have < need) missing[name] = need - have;
    }
    if (Object.keys(missing).length && !a.partial) {
      throw new BodyError(ErrorCodes.MISSING_ITEM, `missing materials: ${Object.entries(missing).map(([n, c]) => `${c} ${n}`).join(', ')}`, { missing, bom });
    }
    // 3) place bottom-up
    const ordered = orderPlacements(todo, bot.entity.position);
    const before = inventorySummary(bot);
    const failures: { block: BlockPlacement; error: string }[] = [];
    let placed = 0;
    let skipped = 0;
    for (let i = 0; i < ordered.length; i++) {
      throwIfAborted(ctx.signal);
      const b = ordered[i] as BlockPlacement;
      const existing = bot.blockAt(new Vec3(b.x, b.y, b.z));
      if (existing && !isReplaceable(existing)) {
        skipped += 1;
        continue;
      }
      if (countItem(bot, b.name) === 0) {
        failures.push({ block: b, error: 'out of material' });
        if (a.strict) break;
        continue;
      }
      try {
        const res = await placeBlockAt(bot, b.name, b, ctx.signal);
        if (res.placed) placed += 1;
        else failures.push({ block: b, error: res.reason ?? 'not placed' });
      } catch (err) {
        if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
        failures.push({ block: b, error: (err as Error).message });
        if (a.strict) break;
      }
      if (i % 10 === 9) ctx.progress(`built ${placed}/${ordered.length}`, { placed, failures: failures.length });
    }
    return {
      planned: a.blocks.length,
      alreadyCorrect: a.blocks.length - todo.length,
      placed,
      skipped,
      failures: failures.slice(0, 25),
      failureCount: failures.length,
      missing,
      inventoryDelta: inventoryDelta(before, inventorySummary(bot)),
    };
  },
});

defineAction({
  name: 'clear_area',
  category: 'building',
  description: 'Dig out every non-air block in a box (site preparation). Bounded to 2048 blocks.',
  longRunning: true,
  schema: z.object({
    min: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    max: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    keep: z.array(z.string()).default(['bedrock', 'water', 'lava']).describe('block names never dug'),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const lo = { x: Math.min(a.min.x, a.max.x), y: Math.min(a.min.y, a.max.y), z: Math.min(a.min.z, a.max.z) };
    const hi = { x: Math.max(a.min.x, a.max.x), y: Math.max(a.min.y, a.max.y), z: Math.max(a.min.z, a.max.z) };
    const volume = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1);
    if (volume > 2048) throw new BodyError(ErrorCodes.BAD_REQUEST, `area too large (${volume} blocks, max 2048)`);
    const keep = new Set(a.keep.map(normalizeName));
    const targets: Vec3[] = [];
    for (let y = hi.y; y >= lo.y; y--) for (let x = lo.x; x <= hi.x; x++) for (let z = lo.z; z <= hi.z; z++) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b && !isReplaceable(b) && !keep.has(b.name)) targets.push(new Vec3(x, y, z));
    }
    const { getAction } = await import('./registry.js');
    const dig = getAction('dig');
    let dug = 0;
    const failures: string[] = [];
    for (const t of targets) {
      throwIfAborted(ctx.signal);
      try {
        await dig.run(ctx, { x: t.x, y: t.y, z: t.z, collect: false });
        dug += 1;
      } catch (err) {
        if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
        failures.push(`${t}: ${(err as Error).message}`);
      }
      if (dug % 10 === 0) ctx.progress(`cleared ${dug}/${targets.length}`);
    }
    return { targets: targets.length, dug, failures: failures.slice(0, 20) };
  },
});
