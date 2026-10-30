import { z } from 'zod';
import type { Block } from 'prismarine-block';
import type { Recipe } from 'prismarine-recipe';
import { BodyError, ErrorCodes } from '../protocol.js';
import { ESCAPE_PROFILE, goToBlock } from '../motor/movement.js';
import { findPlacementSpotNear, placeBlockAt } from '../motor/placing.js';
import { countItem, findItem, inventorySummary, normalizeName, resolveItemNames } from '../motor/items.js';
import { raceAbort, sleep, throwIfAborted, waitFor } from '../util/async.js';
import { distance } from '../util/geometry.js';
import { inventoryDelta } from './mining.js';
import { SMELTING, UTILITY_SEARCH_RADIUS } from '../motor/procurement.js';
import { defineAction, type ActionContext } from './registry.js';

/** How many items one unit of fuel smelts (vanilla values). */
export const FUEL_ITEMS_PER_UNIT: Record<string, number> = {
  lava_bucket: 100,
  coal_block: 80,
  dried_kelp_block: 20,
  blaze_rod: 12,
  coal: 8,
  charcoal: 8,
  // logs / planks and friends
  oak_log: 1.5,
  spruce_log: 1.5,
  birch_log: 1.5,
  jungle_log: 1.5,
  acacia_log: 1.5,
  dark_oak_log: 1.5,
  mangrove_log: 1.5,
  cherry_log: 1.5,
  oak_planks: 1.5,
  spruce_planks: 1.5,
  birch_planks: 1.5,
  jungle_planks: 1.5,
  acacia_planks: 1.5,
  dark_oak_planks: 1.5,
  mangrove_planks: 1.5,
  cherry_planks: 1.5,
  bamboo_planks: 1.5,
  stick: 0.5,
  bamboo: 0.25,
};

export interface MissingIngredient {
  name: string;
  missing: number;
}

export interface RecipeView {
  result: string;
  resultCount: number;
  requiresTable: boolean;
  ingredients: { name: string; count: number }[];
  craftableNow: boolean;
  missing: MissingIngredient[];
}

function itemName(ctx: ActionContext, id: number): string {
  return ctx.bot.registry.items[id]?.name ?? `item_${id}`;
}

/** Inspect every recipe for an item and compute what is missing to craft it `count` times. */
export function describeRecipes(ctx: ActionContext, name: string, count = 1, table: Block | null = null): RecipeView[] {
  const bot = ctx.bot;
  const names = resolveItemNames(bot, name);
  const out: RecipeView[] = [];
  for (const n of names) {
    const def = bot.registry.itemsByName[n];
    if (!def) continue;
    const all = bot.recipesAll(def.id, null, table ?? true) as Recipe[];
    const now = new Set((bot.recipesFor(def.id, null, 1, table ?? true) as Recipe[]).map((r) => r));
    for (const r of all) {
      const consumed = new Map<number, number>();
      for (const d of r.delta) {
        if (d.count < 0) consumed.set(d.id, (consumed.get(d.id) ?? 0) + -d.count);
      }
      const perCraft = r.result.count;
      const crafts = Math.ceil(count / perCraft);
      const missing: MissingIngredient[] = [];
      const ingredients = [...consumed.entries()].map(([id, c]) => ({ name: itemName(ctx, id), count: c * crafts }));
      for (const [id, c] of consumed) {
        const have = bot.inventory.count(id, null);
        const need = c * crafts;
        if (have < need) missing.push({ name: itemName(ctx, id), missing: need - have });
      }
      out.push({
        result: n,
        resultCount: perCraft,
        requiresTable: r.requiresTable,
        ingredients,
        craftableNow: now.has(r) && missing.length === 0,
        missing,
      });
    }
  }
  // most feasible first
  return out.sort((a, b) => Number(b.craftableNow) - Number(a.craftableNow) || a.missing.length - b.missing.length);
}

/** Find a crafting table nearby, or place one from the inventory (crafting it from planks if possible). */
function canMakeTable(bot: ActionContext['bot']): boolean {
  const items = bot.inventory.items();
  return items.some((i) => i.name.endsWith('_planks') && i.count >= 4) || items.some((i) => i.name.endsWith('_log'));
}

export async function ensureCraftingTable(ctx: ActionContext, maxDistance = UTILITY_SEARCH_RADIUS): Promise<Block> {
  const bot = ctx.bot;
  const tableId = bot.registry.blocksByName['crafting_table']?.id;
  if (tableId === undefined) throw new BodyError(ErrorCodes.INTERNAL, 'no crafting_table in registry');
  const existing = bot.findBlock({ matching: tableId, maxDistance });
  if (existing) {
    try {
      await goToBlock(bot, existing.position, ctx.signal, 20_000);
      return existing;
    } catch (err) {
      if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
      // close as the crow flies but not by foot (behind walls, the other end of a tunnel): a player puts down a new
      // one rather than walking for a minute (seen live: `craft furnace` timed out walking to the old table)
      ctx.progress(`the crafting table at ${existing.position} is out of reach: setting up one here`);
    }
  }
  if (!findItem(bot, 'crafting_table') && existing && !canMakeTable(bot)) {
    // no way to make a new one: the old table is worth the long walk after all — and, walled in without a pickaxe,
    // worth breaking the way out by hand (seen live: sealed behind its own cobblestone after the pickaxe wore out)
    try {
      await goToBlock(bot, existing.position, ctx.signal, 30_000);
    } catch (err) {
      if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
      ctx.progress('no way to the crafting table on foot: breaking through by hand');
      await goToBlock(bot, existing.position, ctx.signal, 120_000, ESCAPE_PROFILE);
    }
    return existing;
  }
  if (!findItem(bot, 'crafting_table')) {
    // try to craft one from planks (2x2 recipe, no table needed)
    const planks = bot.inventory.items().find((i) => i.name.endsWith('_planks') && i.count >= 4);
    if (!planks) {
      const logs = bot.inventory.items().find((i) => i.name.endsWith('_log'));
      if (logs) {
        const plankName = logs.name.replace('_log', '_planks');
        await craftWithoutTable(ctx, plankName, 4);
      }
    }
    const haveNow = bot.inventory.items().find((i) => i.name.endsWith('_planks') && i.count >= 4);
    if (!haveNow) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no crafting table nearby and not enough planks (need 4) to craft one');
    await craftWithoutTable(ctx, 'crafting_table', 1);
  }
  const spot = findPlacementSpotNear(bot, 3);
  if (!spot) throw new BodyError(ErrorCodes.NOT_FOUND, 'no free spot near me to place a crafting table');
  const placed = await placeBlockAt(bot, 'crafting_table', spot, ctx.signal);
  if (!placed.placed) throw new BodyError(ErrorCodes.INTERNAL, `could not place crafting table: ${placed.reason}`);
  const block = bot.blockAt(spot);
  if (!block || block.name !== 'crafting_table') throw new BodyError(ErrorCodes.INTERNAL, 'crafting table vanished after placement');
  ctx.progress('placed a crafting table', { position: spot });
  return block;
}

async function craftWithoutTable(ctx: ActionContext, name: string, count: number): Promise<void> {
  const bot = ctx.bot;
  const def = bot.registry.itemsByName[normalizeName(name)];
  if (!def) throw new BodyError(ErrorCodes.NOT_FOUND, `unknown item ${name}`);
  const recipes = bot.recipesFor(def.id, null, 1, null) as Recipe[];
  const r = recipes.find((x) => !x.requiresTable);
  if (!r) throw new BodyError(ErrorCodes.MISSING_ITEM, `cannot craft ${name} in the 2x2 grid with what I have`);
  const crafts = Math.ceil(count / r.result.count);
  await raceAbort(bot.craft(r, crafts), ctx.signal, { timeoutMs: 15_000 });
}

defineAction({
  name: 'craft',
  category: 'crafting',
  description:
    'Craft an item (walks to / places a crafting table when the recipe needs one). Fails with MISSING_ITEM listing exactly what is missing.',
  longRunning: true,
  schema: z.object({
    name: z.string().describe('item name, e.g. "wooden_pickaxe", "oak_planks", "torch"'),
    count: z.number().int().min(1).max(256).default(1).describe('how many items (not crafts) you want'),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const names = resolveItemNames(bot, a.name);
    const def = names.map((n) => bot.registry.itemsByName[n]).find((d) => !!d);
    if (!def) throw new BodyError(ErrorCodes.NOT_FOUND, `unknown item: ${a.name}`);

    const before = inventorySummary(bot);
    const startCount = countItem(bot, def.name);
    const target = startCount + a.count;

    // Decide whether we need a table: any recipe craftable now without table?
    let table: Block | null = null;
    let recipes = bot.recipesFor(def.id, null, 1, null) as Recipe[];
    if (!recipes.length) {
      const tableRecipes = bot.recipesAll(def.id, null, true) as Recipe[];
      if (!tableRecipes.length) throw new BodyError(ErrorCodes.NOT_FOUND, `${def.name} has no crafting recipe`);
      // Need a table (or missing ingredients). Compute the missing list against table recipes first.
      const views = describeRecipes(ctx, def.name, a.count, null);
      const best = views[0];
      if (best && best.missing.length) {
        throw new BodyError(ErrorCodes.MISSING_ITEM, `cannot craft ${def.name}: missing ${best.missing.map((m) => `${m.missing} ${m.name}`).join(', ')}`, {
          missing: best.missing,
          recipe: best,
        });
      }
      table = await ensureCraftingTable(ctx);
      recipes = bot.recipesFor(def.id, null, 1, table) as Recipe[];
      if (!recipes.length) throw new BodyError(ErrorCodes.MISSING_ITEM, `cannot craft ${def.name} even with a table — check ingredients`);
    }

    let crafted = 0;
    let guard = 0;
    while (countItem(bot, def.name) < target && guard++ < 64) {
      throwIfAborted(ctx.signal);
      recipes = bot.recipesFor(def.id, null, 1, table) as Recipe[];
      const r = recipes[0];
      if (!r) break;
      const remaining = target - countItem(bot, def.name);
      const crafts = Math.max(1, Math.min(Math.ceil(remaining / r.result.count), 16));
      await raceAbort(bot.craft(r, crafts, table ?? undefined), ctx.signal, {
        timeoutMs: 20_000,
        // a stuck craft leaves ingredients in the grid: closing the window makes the server hand them back
        onCancel: () => {
          if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
        },
      });
      crafted += crafts * r.result.count;
      await sleep(80, ctx.signal);
    }
    const finalCount = countItem(bot, def.name);
    if (finalCount < target) {
      const views = describeRecipes(ctx, def.name, target - finalCount, table);
      const best = views[0];
      throw new BodyError(ErrorCodes.MISSING_ITEM, `crafted ${finalCount - startCount}/${a.count} ${def.name}; missing ${best?.missing.map((m) => `${m.missing} ${m.name}`).join(', ') ?? 'ingredients'}`, {
        missing: best?.missing ?? [],
      });
    }
    return { item: def.name, crafted: finalCount - startCount, usedTable: !!table, inventoryDelta: inventoryDelta(before, inventorySummary(bot)) };
  },
});

defineAction({
  name: 'recipes',
  category: 'crafting',
  description: 'List recipes for an item with ingredients and what is missing from the inventory.',
  longRunning: false,
  schema: z.object({ name: z.string(), count: z.number().int().min(1).max(256).default(1) }),
  async run(ctx, a) {
    const views = describeRecipes(ctx, a.name, a.count, null);
    if (!views.length) throw new BodyError(ErrorCodes.NOT_FOUND, `no recipe known for ${a.name}`);
    return { recipes: views.slice(0, 8) };
  },
});

/** Pick the best fuel in inventory for `items` items to smelt. */
export function chooseFuel(ctx: ActionContext, items: number, preferred?: string): { name: string; count: number } | null {
  const bot = ctx.bot;
  const inv = inventorySummary(bot);
  const candidates = inv
    .filter((i) => (preferred ? resolveItemNames(bot, preferred).includes(i.name) : FUEL_ITEMS_PER_UNIT[i.name] !== undefined))
    .map((i) => ({ name: i.name, have: i.count, per: FUEL_ITEMS_PER_UNIT[i.name] ?? 1 }))
    // prefer coal/charcoal, then anything that isn't a precious resource
    .sort((x, y) => y.per - x.per);
  for (const c of candidates) {
    if (c.name === 'lava_bucket' && items < 20) continue; // don't waste a lava bucket on 3 items
    const need = Math.ceil(items / c.per);
    if (c.have >= need) return { name: c.name, count: need };
  }
  const first = candidates[0];
  return first ? { name: first.name, count: first.have } : null;
}

defineAction({
  name: 'smelt',
  category: 'crafting',
  description: 'Smelt/cook items in a furnace (finds or places one, picks fuel from the inventory, waits, takes the output).',
  longRunning: true,
  schema: z.object({
    name: z.string().describe('input item, e.g. "raw_iron", "beef", "sand" — or the wanted output ("iron_ingot", "cooked_beef"), which is read as its input'),
    count: z.number().int().min(1).max(64).default(1),
    fuel: z.string().optional().describe('fuel item to use; auto-selected when omitted'),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    // the wanted output is a natural way to say it ("smelt iron_ingot"): read it as its input (seen live)
    const wanted = normalizeName(a.name);
    const inputName = !findItem(bot, wanted) && SMELTING[wanted] ? SMELTING[wanted] : a.name;
    const input = findItem(bot, inputName);
    if (!input) throw new BodyError(ErrorCodes.MISSING_ITEM, inputName === a.name ? `I don't have any ${a.name} to smelt` : `${a.name} is smelted from ${inputName}, and I have none`);
    const count = Math.min(a.count, input.count);
    const fuel = chooseFuel(ctx, count, a.fuel);
    if (!fuel) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no fuel in inventory (coal, charcoal, planks, logs...)');

    const furnaceIds = ['furnace', 'blast_furnace', 'smoker'].map((n) => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined);
    let furnace = bot.findBlock({ matching: furnaceIds, maxDistance: 32 });
    if (!furnace) {
      if (!findItem(bot, 'furnace')) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no furnace nearby and none in inventory (craft one from 8 cobblestone)');
      const spot = findPlacementSpotNear(bot, 3);
      if (!spot) throw new BodyError(ErrorCodes.NOT_FOUND, 'no free spot to place a furnace');
      await placeBlockAt(bot, 'furnace', spot, ctx.signal);
      furnace = bot.blockAt(spot);
      if (!furnace || !furnaceIds.includes(furnace.type)) throw new BodyError(ErrorCodes.INTERNAL, 'furnace placement failed');
    }
    try {
      await goToBlock(bot, furnace.position, ctx.signal, 20_000);
    } catch (err) {
      if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
      if (!findItem(bot, 'furnace')) throw err;
      // the known furnace is out of reach: use the one I carry
      const spot = findPlacementSpotNear(bot, 3);
      if (!spot) throw new BodyError(ErrorCodes.NOT_FOUND, 'the furnace is out of reach and there is no free spot to place mine');
      await placeBlockAt(bot, 'furnace', spot, ctx.signal);
      const placed = bot.blockAt(spot);
      if (!placed || !furnaceIds.includes(placed.type)) throw new BodyError(ErrorCodes.INTERNAL, 'furnace placement failed');
      furnace = placed;
    }
    const before = inventorySummary(bot);
    const win = await raceAbort(bot.openFurnace(furnace), ctx.signal, { timeoutMs: 10_000 });
    try {
      const existingOut = win.outputItem();
      if (existingOut) await win.takeOutput();
      const fuelItem = bot.registry.itemsByName[fuel.name];
      if (fuelItem && !win.fuelItem()) await win.putFuel(fuelItem.id, null, fuel.count);
      await win.putInput(input.type, null, count);
      ctx.progress(`smelting ${count} ${input.name} with ${fuel.count} ${fuel.name}`);
      // ~10 s per item at 20 tps; wait until output reaches count or progress stalls
      const perItemMs = furnace.name === 'furnace' ? 10_000 : 5_000;
      let taken = 0;
      let lastChange = Date.now();
      let lastOut = 0;
      while (taken < count) {
        throwIfAborted(ctx.signal);
        await sleep(500, ctx.signal);
        const out = win.outputItem();
        const outCount = out?.count ?? 0;
        if (outCount !== lastOut) {
          lastOut = outCount;
          lastChange = Date.now();
        }
        if (out && (outCount >= count - taken || outCount >= 64)) {
          await win.takeOutput();
          taken += outCount;
          lastOut = 0;
          lastChange = Date.now();
          continue;
        }
        const inputLeft = win.inputItem()?.count ?? 0;
        if (inputLeft === 0 && outCount === 0 && taken > 0) break;
        if (Date.now() - lastChange > perItemMs * 2 + 5_000) {
          if (out) {
            await win.takeOutput();
            taken += outCount;
          }
          throw new BodyError(ErrorCodes.TIMEOUT, `furnace stalled after ${taken} items (fuel: ${win.fuelItem()?.count ?? 0} ${fuel.name} left)`);
        }
      }
      return { input: input.name, smelted: taken, fuel, inventoryDelta: inventoryDelta(before, inventorySummary(bot)) };
    } finally {
      await win.close();
    }
  },
});

export async function waitForInventory(ctx: ActionContext, name: string, count: number, timeoutMs: number): Promise<void> {
  await waitFor(() => countItem(ctx.bot, name) >= count, { timeoutMs, signal: ctx.signal, message: `did not receive ${count} ${name}` });
}

export function dist(ctx: ActionContext, block: Block): number {
  return distance(ctx.bot.entity.position, block.position);
}
