import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import { ProcurementPlanner, describePlan, isFeasible, isRawMaterial, mergeSteps, type PlanStep } from '../src/motor/procurement.js';

const registry = minecraftData('1.21.11');

function planner(inventory: Record<string, number> = {}, extra: Partial<ConstructorParameters<typeof ProcurementPlanner>[0]> = {}) {
  return new ProcurementPlanner({ registry, inventory, ...extra });
}

describe('procurement planner', () => {
  it('plans a wooden pickaxe from nothing: logs → planks → table → sticks → pickaxe', () => {
    const plan = planner().plan('wooden_pickaxe');
    const kinds = plan.steps.map((s) => `${s.kind}:${s.item}`);
    expect(kinds[0]).toMatch(/^mine:.*_log$/);
    expect(kinds).toContain('craft:oak_planks');
    expect(kinds).toContain('craft:crafting_table');
    expect(kinds).toContain('place_table:crafting_table');
    expect(kinds).toContain('craft:stick');
    expect(kinds[kinds.length - 1]).toBe('craft:wooden_pickaxe');
    expect(plan.unresolved).toEqual([]);
    const text = describePlan(plan);
    expect(text).toMatch(/1\. mine \d+ oak_log/);
    expect(text).toContain('craft 1 wooden_pickaxe at a crafting table');
  });

  it('inserts the required tool before mining ores and smelts raw iron with a furnace', () => {
    const plan = planner({ oak_planks: 20, stick: 8, crafting_table: 1 }, { hasCraftingTableNearby: true }).plan('iron_pickaxe');
    const kinds = plan.steps.map((s) => `${s.kind}:${s.item}`);
    // raw_iron needs at least a stone pickaxe (wooden cannot harvest iron ore in 1.21)
    const mineIron = plan.steps.find((s) => s.kind === 'mine' && s.item === 'raw_iron');
    expect(mineIron).toBeDefined();
    expect(mineIron?.tool).toMatch(/_pickaxe$/);
    expect(kinds.indexOf(`craft:${mineIron?.tool}`)).toBeLessThan(kinds.indexOf('mine:raw_iron'));
    expect(kinds).toContain('mine:cobblestone');
    expect(kinds).toContain('craft:furnace');
    expect(kinds).toContain('smelt:iron_ingot');
    expect(kinds[kinds.length - 1]).toBe('craft:iron_pickaxe');
    expect(plan.materials['raw_iron']).toBe(3);
  });

  it('is incremental: what the inventory already covers is skipped', () => {
    const plan = planner({ iron_ingot: 3, stick: 2, crafting_table: 1 }, { hasCraftingTableNearby: true }).plan('iron_pickaxe');
    expect(plan.steps.map((s) => `${s.kind}:${s.item}`)).toEqual(['craft:iron_pickaxe']);
    const done = planner({ iron_pickaxe: 1 }).plan('iron_pickaxe');
    expect(done.steps).toEqual([]);
    expect(describePlan(done)).toContain('already have');
  });

  it('falls back to mobs and gather hints for non-mineable items, and reports unknowns', () => {
    const bed = planner({ oak_planks: 10 }, { hasCraftingTableNearby: true }).plan('white_bed');
    // wool comes from sheep, or is crafted from string hunted on spiders — both are legitimate
    const woolPath = bed.steps.find((s) => s.item === 'white_wool' && s.kind !== 'craft') ?? bed.steps.find((s) => s.item === 'string');
    expect(woolPath).toBeDefined();
    expect(['hunt', 'acquire']).toContain(woolPath?.kind);
    expect(bed.steps[bed.steps.length - 1]).toMatchObject({ kind: 'craft', item: 'white_bed' });
    const bow = planner({}, { hasCraftingTableNearby: true }).plan('bow');
    const string = bow.steps.find((s) => s.item === 'string');
    expect(string?.kind).toBe('hunt');
    expect(string?.sources).toContain('spider');
    const weird = planner().plan('dragon_egg');
    expect(weird.unresolved).toContain('dragon_egg');
  });

  it('shears sheep for wool when it carries shears, hunts otherwise', () => {
    const withShears = planner({ oak_planks: 10, shears: 1 }, { hasCraftingTableNearby: true }).plan('white_bed');
    expect(withShears.steps.map((s) => `${s.kind}:${s.item}`)).toEqual(['shear:white_wool', 'craft:white_bed']);
    expect(describePlan(withShears)).toContain('shear sheep for 3 white_wool');
    const without = planner({ oak_planks: 10 }, { hasCraftingTableNearby: true }).plan('white_bed');
    expect(without.steps[0]).toMatchObject({ kind: 'hunt', item: 'white_wool', sources: ['sheep'] });
  });

  it('never loops through storage blocks (iron_block ↔ iron_ingot)', () => {
    const plan = planner({ furnace: 1, stone_pickaxe: 1 }, { hasFurnaceNearby: true, hasCraftingTableNearby: true }).plan('iron_ingot', 9);
    const kinds = plan.steps.map((s) => `${s.kind}:${s.item}`);
    expect(kinds).toEqual(['mine:raw_iron', 'smelt:iron_ingot']);
    expect(plan.steps[0]?.count).toBe(9);
  });

  it('handles smelting chains like charcoal → torches and food', () => {
    const torches = planner({ stick: 4, furnace: 1 }, { hasFurnaceNearby: true }).plan('torch', 4);
    const kinds = torches.steps.map((s) => `${s.kind}:${s.item}`);
    expect(kinds[0]).toMatch(/^mine:/); // coal ore or logs for charcoal
    expect(kinds[kinds.length - 1]).toBe('craft:torch');
    const steak = planner({ furnace: 1 }, { hasFurnaceNearby: true }).plan('cooked_beef', 3);
    expect(steak.steps.map((s) => s.kind)).toEqual(['hunt', 'smelt']);
  });

  it('compacts plans: one mining trip, one planks batch, leftovers reused', () => {
    const plan = planner().plan('wooden_pickaxe');
    const kinds = plan.steps.map((s) => `${s.kind}:${s.item}`);
    expect(kinds).toEqual(['mine:oak_log', 'craft:oak_planks', 'craft:crafting_table', 'place_table:crafting_table', 'craft:stick', 'craft:wooden_pickaxe']);
    expect(plan.steps[0]?.count).toBe(3);
    expect(plan.steps[1]?.count).toBe(12);
    expect(plan.steps[1]?.consumes).toEqual({ oak_log: 3 });
    // 11 cobblestone (3 pickaxe + 8 furnace) are mined in a single trip before the stone pickaxe
    const iron = planner().plan('iron_pickaxe');
    const cobble = iron.steps.filter((s) => s.item === 'cobblestone');
    expect(cobble).toHaveLength(1);
    expect(cobble[0]?.count).toBe(11);
    expect(isFeasible(iron.steps)).toBe(true);
  });

  it('refuses to merge a craft whose ingredients only exist later', () => {
    const steps: PlanStep[] = [
      { kind: 'craft', item: 'stick', count: 4, consumes: { oak_planks: 2 } },
      { kind: 'mine', item: 'birch_log', count: 1 },
      { kind: 'craft', item: 'birch_planks', count: 4, consumes: { birch_log: 1 } },
      { kind: 'craft', item: 'stick', count: 4, consumes: { birch_planks: 2 } },
    ];
    const merged = mergeSteps(steps, { oak_planks: 2 });
    expect(merged.map((s) => `${s.kind}:${s.item}`)).toEqual(['craft:stick', 'mine:birch_log', 'craft:birch_planks', 'craft:stick']);
    expect(isFeasible(merged, { oak_planks: 2 })).toBe(true);
    expect(isFeasible([{ kind: 'craft', item: 'stick', count: 8, consumes: { oak_planks: 2, birch_planks: 2 } }], { oak_planks: 2 })).toBe(false);
  });

  it('treats crops and plants as harvestable sources, not storage blocks', () => {
    const bread = planner({ crafting_table: 1 }, { hasCraftingTableNearby: true }).plan('bread', 2);
    expect(bread.unresolved).toEqual([]);
    expect(bread.steps.map((s) => `${s.kind}:${s.item}`)).toEqual(['mine:wheat', 'craft:bread']);
    expect(bread.steps[0]?.count).toBe(6);
  });

  it('merges repeated raw material steps and classifies raw materials', () => {
    const merged = mergeSteps([
      { kind: 'mine', item: 'cobblestone', count: 3 },
      { kind: 'craft', item: 'stick', count: 4 },
      { kind: 'mine', item: 'cobblestone', count: 5 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.count).toBe(8);
    expect(isRawMaterial('oak_log')).toBe(true);
    expect(isRawMaterial('raw_iron')).toBe(true);
    expect(isRawMaterial('iron_pickaxe')).toBe(false);
  });
});
