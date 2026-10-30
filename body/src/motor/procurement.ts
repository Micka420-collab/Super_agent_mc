/**
 * Procurement planner — "get <item>" compiled into a verifiable dependency tree, no LLM involved.
 *
 * The idea comes from AltoClef's TaskCatalogue (MIT), rebuilt on top of minecraft-data: crafting recipes,
 * block loot tables (what a block really drops), entity loot (what a mob drops) and harvest-tool
 * requirements. The planner reasons backward from the wanted item to raw materials, inserting the
 * tools it needs along the way, and produces an ordered list of steps the primitives can execute.
 *
 * Pure functions over a registry snapshot — unit-tested against minecraft-data without a server.
 */
import type { IndexedData } from 'minecraft-data';
import prismarineRecipe from 'prismarine-recipe';
import { normalizeName } from './items.js';

export type StepKind = 'mine' | 'craft' | 'smelt' | 'hunt' | 'shear' | 'place_table' | 'acquire';

export interface PlanStep {
  kind: StepKind;
  /** item produced (or block to place) */
  item: string;
  count: number;
  /** block names to mine, mob names to hunt, recipe inputs for craft/smelt */
  sources?: string[];
  /** minimum tool required, e.g. "wooden_pickaxe" */
  tool?: string;
  /** whether crafting needs a crafting table */
  table?: boolean;
  fuel?: boolean;
  note?: string;
  /** exact inputs this step eats (craft/smelt/place_table) — lets the compactor check merges stay feasible */
  consumes?: Record<string, number>;
}

export interface Plan {
  target: string;
  count: number;
  steps: PlanStep[];
  /** items the planner could not derive (no recipe, no loot) */
  unresolved: string[];
  /** raw materials totals */
  materials: Record<string, number>;
}

/** How far a known crafting table or furnace counts as "mine to use". Shared with `ensureCraftingTable`, so the
 * plan and the execution agree (seen live: the plan ignored a table 31 blocks away and sent the agent to chop wood
 * it could not find, underground, for a whole day). */
export const UTILITY_SEARCH_RADIUS = 48;

/** Smelting recipes minecraft-data does not expose as crafting recipes. */
export const SMELTING: Record<string, string> = {
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  charcoal: 'any_log',
  brick: 'clay_ball',
  nether_brick: 'netherrack',
  cooked_beef: 'beef',
  cooked_porkchop: 'porkchop',
  cooked_chicken: 'chicken',
  cooked_mutton: 'mutton',
  cooked_cod: 'cod',
  cooked_salmon: 'salmon',
  cooked_rabbit: 'rabbit',
  baked_potato: 'potato',
  dried_kelp: 'kelp',
  green_dye: 'cactus',
  cracked_stone_bricks: 'stone_bricks',
  terracotta: 'clay',
  smooth_sandstone: 'sandstone',
  netherite_scrap: 'ancient_debris',
};

/** Items that come from mobs (fallback when no block drops them). */
export const MOB_SOURCES: Record<string, string[]> = {
  string: ['spider', 'cave_spider'],
  leather: ['cow', 'horse', 'llama'],
  beef: ['cow'],
  porkchop: ['pig'],
  chicken: ['chicken'],
  mutton: ['sheep'],
  feather: ['chicken'],
  bone: ['skeleton'],
  gunpowder: ['creeper'],
  ender_pearl: ['enderman'],
  blaze_rod: ['blaze'],
  slime_ball: ['slime'],
  rotten_flesh: ['zombie'],
  spider_eye: ['spider'],
  ink_sac: ['squid'],
  rabbit_hide: ['rabbit'],
  egg: ['chicken'],
  white_wool: ['sheep'],
};

/** Items that are gathered rather than mined/crafted (plants, shearing). */
export const GATHER_HINTS: Record<string, string> = {
  white_wool: 'shear a sheep or kill one',
  wheat: 'harvest wheat crops',
  wheat_seeds: 'break tall grass or harvest wheat',
  sugar_cane: 'break sugar cane near water',
  apple: 'break oak leaves',
  sweet_berries: 'pick a sweet berry bush',
  bamboo: 'break bamboo',
  kelp: 'break kelp underwater',
  cocoa_beans: 'break cocoa pods on jungle logs',
  flint: 'dig gravel (random drop)',
  clay_ball: 'dig clay blocks near water',
  honeycomb: 'shear a full beehive',
};

// ordered by how cheap the tool is to obtain (stone beats copper: no smelting needed)
const TOOL_TIER = ['wooden', 'stone', 'copper', 'golden', 'iron', 'diamond', 'netherite'];
/** Tie-breaker: common materials the agent is most likely to find early. */
const COMMON = new Set(['oak_log', 'oak_planks', 'cobblestone', 'stick', 'coal', 'iron_ingot', 'string', 'white_wool']);
const MAX_DEPTH = 8;
/** Blocks too rare to count as a practical source. */
const RARE_SOURCE_BLOCKS = new Set(['cobweb', 'tripwire', 'spawner', 'trial_spawner', 'bedrock', 'end_portal_frame', 'dragon_egg', 'reinforced_deepslate']);
/** World-generated blocks that legitimately drop themselves. */
const NATURAL_BLOCKS = new Set(['dirt', 'sand', 'red_sand', 'gravel', 'clay', 'netherrack', 'obsidian', 'soul_sand', 'soul_soil', 'end_stone', 'blackstone', 'basalt', 'tuff', 'calcite', 'dripstone_block', 'moss_block', 'mud', 'snow_block', 'ice', 'packed_ice', 'blue_ice', 'magma_block', 'glowstone', 'sea_lantern', 'prismarine', 'sandstone', 'red_sandstone', 'terracotta', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'cobblestone', 'mossy_cobblestone', 'pumpkin', 'melon', 'hay_block', 'bone_block', 'cactus', 'bamboo', 'sugar_cane', 'kelp', 'mushroom_stem', 'brown_mushroom_block', 'red_mushroom_block', 'nether_wart_block', 'warped_wart_block', 'shroomlight', 'sponge', 'wet_sponge', 'ancient_debris', 'amethyst_block', 'budding_amethyst', 'honeycomb_block', 'podzol', 'mycelium', 'rooted_dirt', 'coarse_dirt',
  // crops and plants that drop themselves when broken (the block and the item share a name)
  'wheat', 'nether_wart', 'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus', 'crimson_roots', 'warped_roots', 'nether_sprouts', 'weeping_vines', 'twisting_vines', 'dead_bush', 'vine', 'lily_pad', 'seagrass', 'sea_pickle', 'glow_lichen', 'hanging_roots', 'small_dripleaf', 'big_dripleaf', 'spore_blossom', 'cave_vines', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower', 'sunflower', 'lilac', 'rose_bush', 'peony']);

export interface PlannerInput {
  registry: IndexedData;
  inventory: Record<string, number>;
  /** blocks the agent knows are reachable (optional: used to prefer available sources) */
  knownBlocks?: Set<string>;
  hasCraftingTableNearby?: boolean;
  hasFurnaceNearby?: boolean;
}

export class ProcurementPlanner {
  private readonly Recipe: { find: (id: number, meta: number | null) => Array<{ result: { id: number; count: number }; delta: { id: number; count: number }[]; requiresTable: boolean }> };

  constructor(private readonly input: PlannerInput) {
    const loader = ((prismarineRecipe as unknown as { default?: unknown }).default ?? prismarineRecipe) as (v: string) => { Recipe: unknown };
    this.Recipe = loader(String(input.registry.version.minecraftVersion ?? input.registry.version.majorVersion)).Recipe as typeof this.Recipe;
  }

  private itemName(id: number): string {
    return this.input.registry.items[id]?.name ?? `item_${id}`;
  }

  private itemId(name: string): number | undefined {
    return this.input.registry.itemsByName[name]?.id;
  }

  /** Blocks whose loot table drops this item (without silk touch), nearest-first by rough rarity. */
  blocksDropping(item: string): string[] {
    const loot = (this.input.registry as unknown as { blockLoot?: Record<string, { block: string; drops: { item: string; silkTouch?: boolean; noSilkTouch?: boolean }[] }> }).blockLoot ?? {};
    const out: string[] = [];
    for (const entry of Object.values(loot)) {
      if (RARE_SOURCE_BLOCKS.has(entry.block)) continue;
      // a placed block dropping itself (wool, planks, beds...) is not a natural source
      if (entry.block === item && !isRawMaterial(item) && !NATURAL_BLOCKS.has(item)) continue;
      if (entry.drops.some((d) => d.item === item && !d.silkTouch)) out.push(entry.block);
    }
    // common sense ordering: plain variants before deepslate, avoid "infested"/"bricks" artefacts
    const rank = (b: string) => (b.includes('deepslate') ? 2 : 0) + (b.includes('infested') ? 9 : 0) + (this.input.knownBlocks?.has(b) ? -5 : 0);
    return out.sort((a, b) => rank(a) - rank(b));
  }

  /** Every log block, the ones in view (then oak) first. */
  private logBlocks(): string[] {
    const logs = Object.keys(this.input.registry.blocksByName).filter((n) => n.endsWith('_log') && !n.startsWith('stripped_'));
    const rank = (n: string) => (this.input.knownBlocks?.has(n) ? -2 : 0) + (n === 'oak_log' ? -1 : 0);
    return logs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  /** Minimum tool needed to harvest a block, or null when the hand works. */
  minimumTool(block: string): string | null {
    const def = this.input.registry.blocksByName[block] as { harvestTools?: Record<string, boolean> } | undefined;
    if (!def?.harvestTools) return null;
    const names = Object.keys(def.harvestTools).map((id) => this.itemName(Number(id)));
    names.sort((a, b) => TOOL_TIER.indexOf(a.split('_')[0] ?? '') - TOOL_TIER.indexOf(b.split('_')[0] ?? ''));
    return names[0] ?? null;
  }

  private hasToolFor(block: string): boolean {
    const def = this.input.registry.blocksByName[block] as { harvestTools?: Record<string, boolean> } | undefined;
    if (!def?.harvestTools) return true;
    return Object.keys(def.harvestTools).some((id) => (this.input.inventory[this.itemName(Number(id))] ?? 0) > 0);
  }

  plan(target: string, count = 1): Plan {
    const item = normalizeName(target);
    const steps: PlanStep[] = [];
    const unresolved: string[] = [];
    const materials: Record<string, number> = {};
    const inventory = { ...this.input.inventory };
    const tableState = { placed: !!this.input.hasCraftingTableNearby };
    this.resolve(item, count, inventory, steps, unresolved, materials, new Set(), 0, tableState);
    return { target: item, count, steps: mergeSteps(steps, this.input.inventory), unresolved: [...new Set(unresolved)], materials };
  }

  private resolve(item: string, count: number, inv: Record<string, number>, steps: PlanStep[], unresolved: string[], materials: Record<string, number>, ancestors: Set<string>, depth: number, table: { placed: boolean }): void {
    const have = item === 'any_log' ? sumBy(inv, (n) => n.endsWith('_log')) : item === 'any_planks' ? sumBy(inv, (n) => n.endsWith('_planks')) : inv[item] ?? 0;
    const need = count - have;
    if (need <= 0) {
      consume(inv, item, count);
      return;
    }
    if (depth > MAX_DEPTH || ancestors.has(item)) {
      unresolved.push(item);
      return;
    }
    consume(inv, item, have);
    const next = new Set(ancestors);
    next.add(item);

    // 1. raw material from a block?
    const blocks = item === 'any_log' ? this.logBlocks() : this.blocksDropping(item);
    // unpacking a storage block (hay_block → wheat, iron_block → ingots) is never a way to *obtain* something
    const craftable = this.recipesFor(item).filter((r) => !this.isStorageRoundTrip(r, item));
    const smeltInput = SMELTING[item];
    if (blocks.length && (!craftable.length || isRawMaterial(item))) {
      const block = blocks[0] as string;
      const tool = this.minimumTool(block);
      if (tool && !this.hasToolFor(block)) {
        this.resolve(tool, 1, inv, steps, unresolved, materials, next, depth + 1, table);
        inv[tool] = (inv[tool] ?? 0) + 1;
      }
      steps.push({ kind: 'mine', item, count: need, sources: blocks.slice(0, 4), ...(tool ? { tool } : {}) });
      materials[item] = (materials[item] ?? 0) + need;
      return;
    }
    // 2. smelting
    if (smeltInput) {
      this.resolve(smeltInput, need, inv, steps, unresolved, materials, next, depth + 1, table);
      if (!this.input.hasFurnaceNearby && (inv['furnace'] ?? 0) === 0 && !steps.some((s) => s.item === 'furnace')) {
        this.resolve('furnace', 1, inv, steps, unresolved, materials, next, depth + 1, table);
      }
      steps.push({ kind: 'smelt', item, count: need, sources: [smeltInput], fuel: true, consumes: { [smeltInput]: need } });
      return;
    }
    // 3. curated mob sources beat crafting chains that only hunt anyway (wool from sheep, not 4 string);
    //    with shears in hand, wool is sheared — the sheep lives and regrows it
    if (MOB_SOURCES[item] && !(inv[item] ?? 0)) {
      if (item.endsWith('_wool') && (inv['shears'] ?? 0) > 0) {
        steps.push({ kind: 'shear', item, count: need, sources: ['sheep'] });
      } else {
        steps.push({ kind: 'hunt', item, count: need, sources: MOB_SOURCES[item] as string[] });
      }
      materials[item] = (materials[item] ?? 0) + need;
      return;
    }
    // 4. crafting
    if (craftable.length) {
      const recipe = this.pickRecipe(craftable, inv, next);
      if (recipe) {
        const crafts = Math.ceil(need / recipe.result.count);
        if (recipe.requiresTable && !table.placed) {
          this.resolve('crafting_table', 1, inv, steps, unresolved, materials, next, depth + 1, table);
          steps.push({ kind: 'place_table', item: 'crafting_table', count: 1, consumes: { crafting_table: 1 } });
          table.placed = true;
        }
        const consumed = new Map<string, number>();
        for (const d of recipe.delta) if (d.count < 0) consumed.set(this.itemName(d.id), (consumed.get(this.itemName(d.id)) ?? 0) + -d.count * crafts);
        for (const [ing, c] of consumed) this.resolve(ing, c, inv, steps, unresolved, materials, next, depth + 1, table);
        const produced = crafts * recipe.result.count;
        steps.push({ kind: 'craft', item, count: produced, sources: [...consumed.keys()], table: recipe.requiresTable, consumes: Object.fromEntries(consumed) });
        // leftovers of a batch (4 planks for 2 sticks) stay available for the next step
        if (produced > need) inv[item] = (inv[item] ?? 0) + (produced - need);
        return;
      }
    }
    // 5. mobs (from loot tables)
    const mobs = this.mobsDropping(item);
    if (mobs.length) {
      steps.push({ kind: 'hunt', item, count: need, sources: mobs });
      materials[item] = (materials[item] ?? 0) + need;
      return;
    }
    // 6. gather hints / unknown
    steps.push({ kind: 'acquire', item, count: need, note: GATHER_HINTS[item] ?? 'no known recipe, loot table or mob drop' });
    if (!GATHER_HINTS[item]) unresolved.push(item);
    materials[item] = (materials[item] ?? 0) + need;
  }

  /** A one-ingredient recipe whose ingredient is itself made from `item` (iron_block ↔ iron_ingot). */
  private isStorageRoundTrip(recipe: ReturnType<ProcurementPlanner['recipesFor']>[number], item: string): boolean {
    const ingredients = [...new Set(recipe.delta.filter((d) => d.count < 0).map((d) => this.itemName(d.id)))];
    if (ingredients.length !== 1) return false;
    return this.recipesFor(ingredients[0] as string).some((r) => r.delta.some((d) => d.count < 0 && this.itemName(d.id) === item));
  }

  private mobsDropping(item: string): string[] {
    const loot = (this.input.registry as unknown as { entityLoot?: Record<string, { entity: string; drops: { item: string }[] }> }).entityLoot ?? {};
    return Object.values(loot).filter((e) => e.drops.some((d) => d.item === item)).map((e) => e.entity).slice(0, 4);
  }

  private recipesFor(item: string) {
    const id = this.itemId(item);
    if (id === undefined) return [];
    return this.Recipe.find(id, null);
  }

  /** Rough cost of obtaining one unit of an ingredient right now (lower is better). */
  private ingredientCost(name: string, inv: Record<string, number>): number {
    if ((inv[name] ?? 0) > 0) return 0;
    // wood family: prefer the species we hold or can actually see over the "usual" oak
    if (name.endsWith('_planks')) {
      const log = name.replace('_planks', '_log');
      if ((inv[log] ?? 0) > 0) return 0.5;
      if (this.input.knownBlocks?.has(log)) return 0.8;
    }
    if (COMMON.has(name)) return 1;
    if (isRawMaterial(name)) return 1.5;
    if (this.blocksDropping(name).length) return 2;
    if (MOB_SOURCES[name] || this.mobsDropping(name).length) return 3;
    return 4;
  }

  /**
   * Choose the recipe that is cheapest to satisfy from here: ingredients in hand cost nothing, raw
   * materials little, crafted/hunted items more. Recipes that convert an item of the same family
   * (dyeing a bed into another bed, re-dyeing wool) are heavily penalised; ancestors are forbidden.
   */
  private pickRecipe(recipes: ReturnType<ProcurementPlanner['recipesFor']>, inv: Record<string, number>, ancestors: Set<string>) {
    const target = [...ancestors].pop() ?? '';
    const family = target.includes('_') ? target.slice(target.lastIndexOf('_')) : null;
    const scored = recipes
      .map((r) => {
        const ingredients = r.delta.filter((d) => d.count < 0).map((d) => ({ name: this.itemName(d.id), count: -d.count }));
        if (ingredients.some((i) => ancestors.has(i.name))) return null;
        let score = r.requiresTable ? 1 : 0;
        for (const i of ingredients) {
          score += i.count * this.ingredientCost(i.name, inv);
          if (family && i.name !== target && i.name.endsWith(family)) score += 20;
          if (i.name.endsWith('_dye')) score += 6;
        }
        return { r, score };
      })
      .filter((x): x is { r: ReturnType<ProcurementPlanner['recipesFor']>[number]; score: number } => x !== null)
      .sort((a, b) => a.score - b.score);
    return scored[0]?.r ?? null;
  }
}

function sumBy(inv: Record<string, number>, pred: (name: string) => boolean): number {
  return Object.entries(inv).reduce((s, [n, c]) => (pred(n) ? s + c : s), 0);
}

function consume(inv: Record<string, number>, item: string, count: number): void {
  if (count <= 0) return;
  if (item === 'any_log' || item === 'any_planks') {
    const suffix = item === 'any_log' ? '_log' : '_planks';
    let left = count;
    for (const [n, c] of Object.entries(inv)) {
      if (!n.endsWith(suffix) || left <= 0) continue;
      const take = Math.min(c, left);
      inv[n] = c - take;
      left -= take;
    }
    return;
  }
  inv[item] = Math.max(0, (inv[item] ?? 0) - count);
}

/** Raw materials are things we would rather mine than craft (ores, logs, stone, sand...). */
export function isRawMaterial(item: string): boolean {
  return (
    item.endsWith('_log') ||
    item.endsWith('_ore') ||
    item.startsWith('raw_') ||
    ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'sand', 'gravel', 'coal', 'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz', 'clay_ball', 'flint', 'obsidian', 'netherrack', 'ancient_debris', 'amethyst_shard', 'glowstone_dust', 'snowball', 'ice', 'kelp', 'bamboo', 'sugar_cane', 'cactus', 'any_log'].includes(item)
  );
}

/** Does executing `steps` in order from `inventory` ever consume something that is not there yet? */
export function isFeasible(steps: PlanStep[], inventory: Record<string, number> = {}): boolean {
  const inv: Record<string, number> = { ...inventory };
  for (const s of steps) {
    for (const [name, c] of Object.entries(s.consumes ?? {})) {
      const have = name === 'any_log' ? sumBy(inv, (n) => n.endsWith('_log') || n === 'any_log') : (inv[name] ?? 0);
      if (have < c) return false;
      consume(inv, name, c);
    }
    if (s.kind !== 'place_table') inv[s.item] = (inv[s.item] ?? 0) + s.count;
  }
  return true;
}

/**
 * Compact a plan: a later step for the same item is folded into the first one (mine 1 log, then 1 more,
 * then 1 more → mine 3 logs; craft planks three times → one craft) whenever the merged sequence is
 * still feasible — every step's inputs exist at the moment it runs. Mining/hunting/gathering steps
 * consume nothing, so they always merge; crafting merges only if the ingredients are already there.
 */
export function mergeSteps(steps: PlanStep[], inventory: Record<string, number> = {}): PlanStep[] {
  const out: PlanStep[] = [];
  for (const s of steps) {
    const prev = out.find((o) => o.kind === s.kind && o.item === s.item && o.kind !== 'place_table');
    if (prev) {
      const merged: PlanStep = { ...prev, count: prev.count + s.count };
      if (prev.consumes || s.consumes) {
        merged.consumes = { ...(prev.consumes ?? {}) };
        for (const [n, c] of Object.entries(s.consumes ?? {})) merged.consumes[n] = (merged.consumes[n] ?? 0) + c;
      }
      if (s.sources) merged.sources = [...new Set([...(prev.sources ?? []), ...s.sources])];
      const candidate = out.map((o) => (o === prev ? merged : o));
      if (isFeasible(candidate, inventory)) {
        out.splice(out.indexOf(prev), 1, merged);
        continue;
      }
    }
    out.push({ ...s });
  }
  return out;
}

export function describePlan(plan: Plan): string {
  if (!plan.steps.length) return `already have ${plan.count} ${plan.target}`;
  const lines = plan.steps.map((s, i) => {
    switch (s.kind) {
      case 'mine':
        return `${i + 1}. mine ${s.count} ${s.item} (from ${s.sources?.join('/')}${s.tool ? `, needs ${s.tool}` : ''})`;
      case 'craft':
        return `${i + 1}. craft ${s.count} ${s.item}${s.table ? ' at a crafting table' : ''} from ${s.sources?.join(', ')}`;
      case 'smelt':
        return `${i + 1}. smelt ${s.count} ${s.item} from ${s.sources?.join(', ')} (needs fuel)`;
      case 'hunt':
        return `${i + 1}. hunt ${s.sources?.join('/')} for ${s.count} ${s.item}`;
      case 'shear':
        return `${i + 1}. shear sheep for ${s.count} ${s.item}`;
      case 'place_table':
        return `${i + 1}. place a crafting table`;
      default:
        return `${i + 1}. acquire ${s.count} ${s.item} — ${s.note}`;
    }
  });
  if (plan.unresolved.length) lines.push(`unresolved: ${plan.unresolved.join(', ')}`);
  return lines.join('\n');
}
