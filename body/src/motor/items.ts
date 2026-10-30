/**
 * Inventory & equipment helpers.
 */
import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import type { Block } from 'prismarine-block';
import { BodyError, ErrorCodes } from '../protocol.js';

/** Normalise a user/LLM supplied item or block name: "Oak Log" -> "oak_log", "minecraft:stone" -> "stone". */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_');
}

/**
 * Resolve a possibly fuzzy name to concrete item names present in the registry.
 * Exact match first, then "ends with" (e.g. "log" -> oak_log, birch_log...), then "contains".
 */
export function resolveItemNames(bot: Bot, name: string): string[] {
  const n = normalizeName(name);
  const names = Object.keys(bot.registry.itemsByName);
  if (bot.registry.itemsByName[n]) return [n];
  const ends = names.filter((x) => x.endsWith(`_${n}`) || x.endsWith(n));
  if (ends.length) return ends;
  return names.filter((x) => x.includes(n));
}

export function resolveBlockNames(bot: Bot, name: string): string[] {
  const n = normalizeName(name);
  const names = Object.keys(bot.registry.blocksByName);
  if (bot.registry.blocksByName[n]) return [n];
  // common aliases
  const alias: Record<string, string[]> = {
    wood: names.filter((x) => x.endsWith('_log')),
    log: names.filter((x) => x.endsWith('_log')),
    logs: names.filter((x) => x.endsWith('_log')),
    tree: names.filter((x) => x.endsWith('_log')),
    plank: names.filter((x) => x.endsWith('_planks')),
    planks: names.filter((x) => x.endsWith('_planks')),
    leaves: names.filter((x) => x.endsWith('_leaves')),
    ore: names.filter((x) => x.endsWith('_ore')),
    ores: names.filter((x) => x.endsWith('_ore')),
    bed: names.filter((x) => x.endsWith('_bed')),
    stone: ['stone'],
    cobble: ['cobblestone'],
  };
  if (alias[n]) return alias[n] as string[];
  const ends = names.filter((x) => x.endsWith(`_${n}`));
  if (ends.length) return ends;
  return names.filter((x) => x.includes(n));
}

export function countItem(bot: Bot, name: string): number {
  const candidates = new Set(resolveItemNames(bot, name));
  return bot.inventory.items().filter((i) => candidates.has(i.name)).reduce((s, i) => s + i.count, 0);
}

export function findItem(bot: Bot, name: string): Item | null {
  const candidates = new Set(resolveItemNames(bot, name));
  return bot.inventory.items().find((i) => candidates.has(i.name)) ?? null;
}

export async function equipByName(bot: Bot, name: string, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet' = 'hand'): Promise<Item> {
  const item = findItem(bot, name);
  if (!item) throw new BodyError(ErrorCodes.MISSING_ITEM, `I don't have any ${name}`);
  if (destination === 'hand' && bot.heldItem && bot.heldItem.type === item.type) return item;
  await bot.equip(item, destination);
  return item;
}

const TOOL_MATERIAL_RANK: Record<string, number> = { wooden: 1, stone: 2, golden: 2, iron: 3, diamond: 4, netherite: 5 };

export function materialRank(itemName: string): number {
  const prefix = itemName.split('_')[0] ?? '';
  return TOOL_MATERIAL_RANK[prefix] ?? 0;
}

/** Best melee weapon in inventory (sword > axe > anything), by material rank. */
export function bestWeapon(bot: Bot): Item | null {
  const items = bot.inventory.items();
  const swords = items.filter((i) => i.name.endsWith('_sword')).sort((a, b) => materialRank(b.name) - materialRank(a.name));
  if (swords.length) return swords[0] as Item;
  const axes = items.filter((i) => i.name.endsWith('_axe')).sort((a, b) => materialRank(b.name) - materialRank(a.name));
  if (axes.length) return axes[0] as Item;
  return null;
}

export async function equipBestWeapon(bot: Bot): Promise<Item | null> {
  const w = bestWeapon(bot);
  if (w && (!bot.heldItem || bot.heldItem.type !== w.type)) await bot.equip(w, 'hand');
  return w;
}

/** Equip the best tool for a block (pathfinder's heuristic + the tool plugin when loaded). */
export async function equipBestTool(bot: Bot, block: Block): Promise<void> {
  const toolPlugin = (bot as unknown as { tool?: { equipForBlock: (b: Block, o?: { requireHarvest?: boolean }) => Promise<void> } }).tool;
  if (toolPlugin) {
    try {
      await toolPlugin.equipForBlock(block, { requireHarvest: false });
      return;
    } catch {
      /* fall through */
    }
  }
  const best = bot.pathfinder?.bestHarvestTool?.(block);
  if (best && (!bot.heldItem || bot.heldItem.type !== best.type)) await bot.equip(best, 'hand');
}

export function hasFreeSlot(bot: Bot): boolean {
  return bot.inventory.emptySlotCount() > 0;
}

export interface ItemSummary {
  name: string;
  count: number;
}

export function inventorySummary(bot: Bot): ItemSummary[] {
  const map = new Map<string, number>();
  for (const i of bot.inventory.items()) map.set(i.name, (map.get(i.name) ?? 0) + i.count);
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}
