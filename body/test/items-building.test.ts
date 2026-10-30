import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import { bestWeapon, materialRank, normalizeName, resolveBlockNames, resolveItemNames } from '../src/motor/items.js';
import { billOfMaterials, orderPlacements } from '../src/actions/building.js';
import { splitChat, sanitizeChat } from '../src/actions/social.js';
import { inventoryDelta, isHarvestable } from '../src/actions/mining.js';
import type { ActionContext } from '../src/actions/registry.js';
import { classifyEntity, isThreat } from '../src/perception/entities.js';

const registry = minecraftData('1.21.11');
const fakeBot = (items: { name: string; type: number; count: number }[] = []) =>
  ({ registry, inventory: { items: () => items }, heldItem: null } as unknown as Bot);

describe('item helpers', () => {
  it('normalises names', () => {
    expect(normalizeName('Oak Log')).toBe('oak_log');
    expect(normalizeName('minecraft:stone')).toBe('stone');
    expect(normalizeName(' iron-ore ')).toBe('iron_ore');
  });

  it('resolves fuzzy block names', () => {
    const bot = fakeBot();
    expect(resolveBlockNames(bot, 'stone')).toEqual(['stone']);
    expect(resolveBlockNames(bot, 'log')).toContain('oak_log');
    expect(resolveBlockNames(bot, 'log')).toContain('spruce_log');
    expect(resolveBlockNames(bot, 'bed')).toContain('red_bed');
    expect(resolveBlockNames(bot, 'ore')).toContain('diamond_ore');
    expect(resolveItemNames(bot, 'pickaxe')).toContain('iron_pickaxe');
    expect(resolveItemNames(bot, 'nonexistent_thing')).toEqual([]);
  });

  it('picks the best weapon by material', () => {
    expect(materialRank('netherite_sword')).toBeGreaterThan(materialRank('iron_sword'));
    const sword = registry.itemsByName['stone_sword']!;
    const axe = registry.itemsByName['diamond_axe']!;
    const bot = fakeBot([
      { name: 'diamond_axe', type: axe.id, count: 1 },
      { name: 'stone_sword', type: sword.id, count: 1 },
    ]);
    expect(bestWeapon(bot)?.name).toBe('stone_sword'); // swords beat axes
  });
});

describe('building helpers', () => {
  it('orders placements bottom-up then nearest-first', () => {
    const from = { x: 0, y: 64, z: 0 };
    const ordered = orderPlacements(
      [
        { name: 'stone', x: 5, y: 65, z: 0 },
        { name: 'stone', x: 9, y: 64, z: 0 },
        { name: 'stone', x: 2, y: 64, z: 0 },
      ],
      from,
    );
    expect(ordered.map((b) => [b.x, b.y])).toEqual([
      [2, 64],
      [9, 64],
      [5, 65],
    ]);
  });

  it('computes a bill of materials', () => {
    expect(billOfMaterials([{ name: 'Oak Planks', x: 0, y: 0, z: 0 }, { name: 'oak_planks', x: 1, y: 0, z: 0 }, { name: 'glass', x: 2, y: 0, z: 0 }])).toEqual({ oak_planks: 2, glass: 1 });
  });

  it('only harvests ripe crops', () => {
    const ctx = { bot: fakeBot() } as unknown as ActionContext;
    const block = (name: string, age?: number) => ({ name, getProperties: () => (age === undefined ? {} : { age }) }) as never;
    expect(isHarvestable(ctx, block('wheat', 7))).toBe(true);
    expect(isHarvestable(ctx, block('wheat', 3))).toBe(false);
    expect(isHarvestable(ctx, block('beetroots', 3))).toBe(true);
    expect(isHarvestable(ctx, block('stone'))).toBe(true);
    expect(isHarvestable(ctx, block('oak_log', 0))).toBe(true);
  });

  it('computes inventory deltas', () => {
    expect(inventoryDelta([{ name: 'oak_log', count: 3 }], [{ name: 'oak_log', count: 1 }, { name: 'oak_planks', count: 8 }])).toEqual({ oak_log: -2, oak_planks: 8 });
  });
});

describe('chat helpers', () => {
  it('splits long messages on word boundaries and strips commands', () => {
    const parts = splitChat('word '.repeat(80));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(250);
    expect(sanitizeChat('/op Emeth')).toBe('op Emeth');
    expect(splitChat('   ')).toEqual([]);
  });
});

describe('entity classification', () => {
  it('classifies by name, type and category', () => {
    expect(classifyEntity({ type: 'player', name: 'player' })).toBe('player');
    expect(classifyEntity({ type: 'mob', name: 'zombie', category: 'Hostile mobs' })).toBe('hostile');
    expect(classifyEntity({ type: 'mob', name: 'cow', category: 'Passive mobs' })).toBe('passive');
    expect(classifyEntity({ type: 'mob', name: 'enderman', category: 'Hostile mobs' })).toBe('neutral');
    expect(classifyEntity({ type: 'object', name: 'item', category: 'UNKNOWN' })).toBe('item');
    expect(classifyEntity({ type: 'projectile', name: 'arrow', category: 'Projectiles' })).toBe('projectile');
    expect(isThreat('neutral', 'enderman', false)).toBe(false);
    expect(isThreat('neutral', 'enderman', true)).toBe(true);
    expect(isThreat('neutral', 'spider')).toBe(true);
    expect(isThreat('hostile', 'creeper')).toBe(true);
  });
});

describe('placement safety', () => {
  it('detects when the hitbox straddles the target cell', async () => {
    const { hitboxIntersectsCell } = await import('../src/motor/placing.js');
    // standing at the centre of (10, 5, 9): cell (10, 5, 8) is clear of the hitbox
    expect(hitboxIntersectsCell({ x: 10.5, y: 5, z: 9.5 }, { x: 10, y: 5, z: 8 })).toBe(false);
    // standing on the boundary (z = 8.9): the 0.6-wide box reaches into z = 8
    expect(hitboxIntersectsCell({ x: 10.5, y: 5, z: 8.9 }, { x: 10, y: 5, z: 8 })).toBe(true);
    // the cell under our feet is not intersected (y = 4 is below the box)
    expect(hitboxIntersectsCell({ x: 10.5, y: 5, z: 9.5 }, { x: 10, y: 4, z: 9 })).toBe(false);
    // the head cell is
    expect(hitboxIntersectsCell({ x: 10.5, y: 5, z: 9.5 }, { x: 10, y: 6, z: 9 })).toBe(true);
    // a block two levels up is clear (box top at 6.8 < 7)
    expect(hitboxIntersectsCell({ x: 10.5, y: 5, z: 9.5 }, { x: 10, y: 7, z: 9 })).toBe(false);
  });
});
