import { z } from 'zod';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { BodyError, ErrorCodes } from '../protocol.js';
import { DEFAULT_PROFILE, goTo, goToBlock, type MovementProfile } from '../motor/movement.js';
import { equipBestTool, findItem, hasFreeSlot, inventorySummary, normalizeName, resolveBlockNames, type ItemSummary } from '../motor/items.js';
import { ProcurementPlanner } from '../motor/procurement.js';
import { assessSite, cardinalFromYaw, stairStep, stairUpStep, summariseOres, tunnelStep, type BlockLookup, type Cardinal, type Course, type NamedCell } from '../motor/digging.js';
import { describeOre, miningAdvice } from '../motor/ores.js';
import { placeBlockAt } from '../motor/placing.js';
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

/**
 * Crops only drop their produce when fully grown (loot tables gate on `blockAge`). A real player waits;
 * so do we: immature crops are not candidates for `mine`.
 */
export function isHarvestable(ctx: ActionContext, block: Block): boolean {
  const loot = (ctx.bot.registry as unknown as { blockLoot?: Record<string, { drops: { blockAge?: number }[] }> }).blockLoot?.[block.name];
  const ages = loot?.drops.map((d) => d.blockAge).filter((a): a is number => a !== undefined) ?? [];
  if (!ages.length) return true;
  const props = (block as unknown as { getProperties?: () => Record<string, unknown> }).getProperties?.() ?? {};
  const age = Number(props['age']);
  return Number.isFinite(age) ? age >= Math.max(...ages) : true;
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
    'Find and mine blocks by name (fuzzy: "log" matches every log type), collecting the drops. Fails with MISSING_TOOL when a better pickaxe is required, NOT_FOUND when none is in range (for ores the error says which depth to `descend` to).',
  longRunning: true,
  schema: z.object({
    name: z.string().describe('block name, e.g. "oak_log", "iron_ore", "stone"'),
    count: z.number().int().min(1).max(256).default(1),
    maxDistance: z.number().min(1).max(128).default(32),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    let names = resolveBlockNames(bot, a.name);
    const find = (set: Set<string>) => bot.findBlocks({ matching: (b) => set.has(b.name) && isHarvestable(ctx, b), maxDistance: a.maxDistance, count: Math.max(a.count * 4, 16) });
    let positions = names.length ? find(new Set(names)) : [];
    if (!positions.length) {
      // asked for an item rather than a block (cobblestone, coal, raw_iron…): mine what drops it, as a player would
      const item = normalizeName(a.name);
      const sources = bot.registry.itemsByName[item] ? new ProcurementPlanner({ registry: bot.registry, inventory: {} }).blocksDropping(item).filter((b) => !names.includes(b)) : [];
      const found = sources.length ? find(new Set(sources)) : [];
      if (found.length) {
        ctx.progress(`${item} comes from ${sources.slice(0, 3).join('/')}: mining that`);
        names = sources;
        positions = found;
      }
    }
    if (!names.length) throw new BodyError(ErrorCodes.NOT_FOUND, `unknown block: ${a.name}`);
    if (!positions.length) {
      const advice = miningAdvice(names, bot.entity.position.y, String(bot.game?.dimension ?? 'overworld'));
      const hint = advice.move === 'descend' || advice.move === 'ascend' ? ` — ${advice.reason}: use \`descend\` to Y ${advice.targetY}` : advice.move === 'elsewhere' ? ` — ${advice.reason}` : ' (ripe, if it is a crop) — explore, or `tunnel` if it is an ore';
      throw new BodyError(ErrorCodes.NOT_FOUND, `no ${a.name} within ${a.maxDistance} blocks${hint}`, { advice });
    }
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

// ---------------------------------------------------------------------------------------------
// Digging courses: a staircase down to a depth, a branch-mine tunnel at this level
// ---------------------------------------------------------------------------------------------
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
/** Moving along a course we just dug: never let the pathfinder dig or parkour, every cell is already open. */
const COURSE_PROFILE: MovementProfile = { ...DEFAULT_PROFILE, canDig: false, allowParkour: false, allow1by1towers: false };
const DIRECTION = z.enum(['north', 'south', 'east', 'west']);

interface CourseOptions {
  kind: 'stair' | 'tunnel' | 'ascent';
  /** ascent only: stop as soon as the feet are under the open sky */
  untilSky?: boolean;
  direction?: Cardinal;
  steps: number;
  toY?: number;
  torchEvery: number;
  minHealth: number;
  mineOres: boolean;
}

export interface CourseResult {
  kind: 'stair' | 'tunnel' | 'ascent';
  direction: Cardinal;
  steps: number;
  from: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  /** descend only: the requested depth was reached */
  reachedTarget: boolean;
  torches: number;
  /** ores noticed on the walls/floor/ceiling along the way, by name */
  oresSeen: Record<string, number>;
  oresMined: number;
  hazards: NamedCell[];
  stoppedBecause: string;
  inventoryDelta: Record<string, number>;
}

/** Break one cell until it is air (gravity blocks above keep refilling it: dig, wait, dig again). */
async function clearCell(ctx: ActionContext, cell: { x: number; y: number; z: number }, expectFalling: boolean): Promise<number> {
  const bot = ctx.bot;
  let broken = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    throwIfAborted(ctx.signal);
    const block = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    if (!block || AIR_NAMES.has(block.name)) return broken;
    if (block.hardness === -1 || block.name === 'bedrock') throw new BodyError(ErrorCodes.BAD_REQUEST, `${block.name} cannot be broken`);
    await equipBestTool(bot, block);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await raceAbort(bot.dig(block, true), ctx.signal, { timeoutMs: 30_000, onCancel: () => bot.stopDigging() });
    broken += 1;
    await sleep(expectFalling ? 400 : 60, ctx.signal);
  }
  return broken;
}

function requirePickaxe(ctx: ActionContext): void {
  if (!ctx.bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) {
    throw new BodyError(ErrorCodes.MISSING_TOOL, 'a pickaxe is needed to dig a course through stone', { needed: ['wooden_pickaxe'] });
  }
}

/**
 * Dig a course step by step: survey (`assessSite`), clear the cells top-down, step in, mine the ores the walls
 * expose, light the way, and stop with a precise reason the moment the survey says no.
 */
export async function digCourse(ctx: ActionContext, o: CourseOptions): Promise<CourseResult> {
  const bot = ctx.bot;
  requirePickaxe(ctx);
  const direction = o.direction ?? cardinalFromYaw(bot.entity.yaw);
  const origin = bot.entity.position.floored();
  const lookup: BlockLookup = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? null;
  const before = inventorySummary(bot);
  const oresSeen = new Map<string, NamedCell>();
  const hazards: NamedCell[] = [];
  let steps = 0;
  let torches = 0;
  let oresMined = 0;
  let reachedTarget = false;
  let stoppedBecause = o.kind === 'tunnel' ? `tunnel of ${o.steps} blocks complete` : `dug ${o.steps} steps`;
  let feet = { x: origin.x, y: origin.y, z: origin.z };
  let behind = feet;

  for (let i = 1; i <= o.steps; i++) {
    throwIfAborted(ctx.signal);
    const course: Course = o.kind === 'stair' ? stairStep(origin, direction, i) : o.kind === 'ascent' ? stairUpStep(origin, direction, i) : tunnelStep(origin, direction, i);
    if (o.kind === 'ascent' && o.toY !== undefined && course.feet.y > o.toY) {
      reachedTarget = true;
      stoppedBecause = `reached Y ${feet.y}`;
      break;
    }
    if (o.kind === 'stair' && o.toY !== undefined && course.feet.y < o.toY) {
      reachedTarget = true;
      stoppedBecause = `reached Y ${feet.y}`;
      break;
    }
    const report = assessSite(lookup, course);
    for (const ore of report.ores) oresSeen.set(`${ore.x},${ore.y},${ore.z}`, ore);
    if (!report.ok) {
      hazards.push(...report.hazards);
      stoppedBecause = report.stop ?? 'survey refused the next step';
      break;
    }
    for (const cell of [...course.clear].reverse()) await clearCell(ctx, cell, report.falling.length > 0);
    try {
      await goTo(bot, { x: course.feet.x + 0.5, y: course.feet.y, z: course.feet.z + 0.5 }, 0.6, ctx.signal, { timeoutMs: 12_000, profile: COURSE_PROFILE });
    } catch (err) {
      if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
      stoppedBecause = `could not step into the next cell: ${(err as Error).message}`;
      break;
    }
    behind = feet;
    feet = course.feet;
    steps += 1;

    if (o.mineOres) {
      // walls and ceiling only: opening the floor would drop us into whatever is below
      for (const ore of report.ores.filter((c) => c.y >= course.feet.y)) {
        throwIfAborted(ctx.signal);
        const stillThere = bot.blockAt(new Vec3(ore.x, ore.y, ore.z));
        if (!stillThere || stillThere.name !== ore.name) continue;
        if (!canHarvest(ctx, stillThere).ok) continue;
        oresMined += await clearCell(ctx, ore, false);
        ctx.progress(`mined ${ore.name} from the wall`, { ore });
      }
    }
    if (i % o.torchEvery === 0 && findItem(bot, 'torch')) {
      try {
        await placeBlockAt(bot, 'torch', behind, ctx.signal);
        torches += 1;
      } catch (err) {
        if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
        ctx.log.debug({ err }, 'no spot for a torch here');
      }
    }
    ctx.progress(`${o.kind === 'stair' ? 'descending' : o.kind === 'ascent' ? 'climbing' : 'tunnelling'} ${direction}: step ${i}/${o.steps}, Y ${feet.y}`, { feet, oresSeen: oresSeen.size });
    if (o.kind === 'ascent' && o.untilSky && (bot.blockAt(new Vec3(feet.x, feet.y + 1, feet.z))?.skyLight ?? 0) >= 14) {
      reachedTarget = true;
      stoppedBecause = `out under the open sky at Y ${feet.y}`;
      break;
    }
    if (bot.health < o.minHealth) {
      stoppedBecause = `health ${bot.health} below ${o.minHealth}`;
      break;
    }
    if (!hasFreeSlot(bot)) {
      stoppedBecause = 'inventory full';
      break;
    }
  }
  if (o.kind === 'stair' && o.toY !== undefined && feet.y <= o.toY) reachedTarget = true;
  if (o.kind === 'ascent' && o.toY !== undefined && feet.y >= o.toY && !reachedTarget) {
    reachedTarget = true;
    stoppedBecause = `reached Y ${feet.y}`;
  }
  await sleep(300, ctx.signal);
  return {
    kind: o.kind,
    direction,
    steps,
    from: { x: origin.x, y: origin.y, z: origin.z },
    end: feet,
    reachedTarget,
    torches,
    oresSeen: summariseOres([...oresSeen.values()]),
    oresMined,
    hazards,
    stoppedBecause,
    inventoryDelta: inventoryDelta(before, inventorySummary(bot)),
  };
}

defineAction({
  name: 'descend',
  category: 'mining',
  description:
    'Dig a safe 1-wide staircase down to a target Y (surveying every step for lava, water, holes, gravel and unloaded chunks, lighting it with torches, mining ores exposed on the way). The way to reach ore depths: diamonds/redstone Y -58, gold -16, lapis 0, iron 16, copper 48. Stops with the reason and the exact position when it cannot continue safely.',
  longRunning: true,
  schema: z.object({
    toY: z.number().int().min(-64).max(320).describe('the Y level to stand at when done'),
    direction: DIRECTION.optional().describe('defaults to where I am looking'),
    torchEvery: z.number().int().min(2).max(32).default(6),
    minHealth: z.number().min(0).max(20).default(8),
    maxSteps: z.number().int().min(1).max(400).default(200),
    mineOres: z.boolean().default(true),
  }),
  async run(ctx, a) {
    const y = Math.floor(ctx.bot.entity.position.y);
    if (y <= a.toY) return { kind: 'stair', steps: 0, reachedTarget: true, stoppedBecause: `already at Y ${y}, at or below ${a.toY}`, end: ctx.bot.entity.position.floored(), oresSeen: {} };
    const steps = Math.min(a.maxSteps, y - a.toY);
    return digCourse(ctx, { kind: 'stair', direction: a.direction, steps, toY: a.toY, torchEvery: a.torchEvery, minHealth: a.minHealth, mineOres: a.mineOres });
  },
});

defineAction({
  name: 'ascend',
  category: 'mining',
  description:
    'Dig a safe 1-wide staircase UP — the way out of a pit, a cave or a sealed shelter when walking (`goto`) finds no path. Surveys every step (lava, water, gravel that would fall, unloaded chunks) and stops under the open sky (default) or at `toY`. Needs a pickaxe.',
  longRunning: true,
  schema: z.object({
    toY: z.number().int().min(-64).max(320).optional().describe('stop at this Y; default: climb until under the open sky'),
    direction: DIRECTION.optional().describe('defaults to where I am looking — face your destination'),
    torchEvery: z.number().int().min(2).max(32).default(8),
    minHealth: z.number().min(0).max(20).default(6),
    maxSteps: z.number().int().min(1).max(200).default(96),
    mineOres: z.boolean().default(true),
  }),
  async run(ctx, a) {
    const y = Math.floor(ctx.bot.entity.position.y);
    if (a.toY !== undefined && y >= a.toY) return { kind: 'ascent', steps: 0, reachedTarget: true, stoppedBecause: `already at Y ${y}, at or above ${a.toY}`, end: ctx.bot.entity.position.floored(), oresSeen: {} };
    const steps = a.toY !== undefined ? Math.min(a.maxSteps, a.toY - y) : a.maxSteps;
    return digCourse(ctx, { kind: 'ascent', direction: a.direction, steps, toY: a.toY, untilSky: a.toY === undefined, torchEvery: a.torchEvery, minHealth: a.minHealth, mineOres: a.mineOres });
  },
});

defineAction({
  name: 'tunnel',
  category: 'mining',
  description:
    'Branch-mine: dig a straight 1×2 tunnel at this level for `length` blocks, surveying every step (lava, water, drops, gravel), mining the ores exposed on the walls and ceiling, placing torches. Use it at the right depth (see `descend`) to find ores that are not in sight.',
  longRunning: true,
  schema: z.object({
    length: z.number().int().min(1).max(64).default(16),
    direction: DIRECTION.optional().describe('defaults to where I am looking'),
    torchEvery: z.number().int().min(2).max(32).default(8),
    minHealth: z.number().min(0).max(20).default(8),
    mineOres: z.boolean().default(true),
  }),
  run: (ctx, a) => digCourse(ctx, { kind: 'tunnel', direction: a.direction, steps: a.length, torchEvery: a.torchEvery, minHealth: a.minHealth, mineOres: a.mineOres }),
});

defineAction({
  name: 'ore_info',
  category: 'mining',
  description: 'Where an ore generates (Y span, best level) and whether to descend from here. Free, no movement.',
  longRunning: false,
  schema: z.object({ name: z.string().describe('ore or item name, e.g. "diamond", "iron_ore"') }),
  async run(ctx, a) {
    const names = resolveBlockNames(ctx.bot, a.name.endsWith('_ore') || a.name === 'ancient_debris' ? a.name : `${a.name}_ore`);
    const all = names.length ? names : resolveBlockNames(ctx.bot, a.name);
    const advice = miningAdvice(all, ctx.bot.entity.position.y, String(ctx.bot.game?.dimension ?? 'overworld'));
    return { blocks: all.slice(0, 4), info: all.map(describeOre).find((d) => d !== null) ?? null, advice, currentY: Math.floor(ctx.bot.entity.position.y) };
  },
});
