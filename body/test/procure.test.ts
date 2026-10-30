/**
 * The `get` control loop against a simulated world: every primitive it delegates to is faked with
 * simple, honest physics (blocks exist or not, tools gate ores, recipes consume inputs, mobs drop
 * loot when killed). What is under test is the loop itself — re-planning, exploration, stall
 * detection, blocking and budget — not mineflayer.
 */
import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import prismarineRecipe from 'prismarine-recipe';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import '../src/actions/index.js';
import { executeStep, plannerFor, runGet, type ProcureDeps } from '../src/actions/procure.js';
import { SMELTING } from '../src/motor/procurement.js';
import type { ActionContext } from '../src/actions/registry.js';
import { BodyError, ErrorCodes } from '../src/protocol.js';
import { resolveBlockNames } from '../src/motor/items.js';

const registry = minecraftData('1.21.11');
const { Recipe } = (((prismarineRecipe as unknown as { default?: unknown }).default ?? prismarineRecipe) as (v: string) => { Recipe: RecipeStatic })('1.21.11');

interface RecipeStatic {
  find: (id: number, meta: number | null) => Array<{ result: { id: number; count: number }; delta: { id: number; count: number }[]; requiresTable: boolean }>;
}

interface FakeEntity {
  id: number;
  name: string;
  position: Vec3;
  drops: Record<string, number>;
}

interface World {
  /** block name → how many are reachable */
  blocks: Record<string, number>;
  entities: FakeEntity[];
  tableNearby: boolean;
  furnaceNearby: boolean;
  /** hook: terrain revealed by exploring */
  onExplore?: (w: World) => void;
  /** per block name: what actually drops (overrides loot tables; empty object = nothing) */
  dropOverride?: Record<string, Record<string, number>>;
}

class Sim {
  readonly inv = new Map<string, number>();
  readonly calls: string[] = [];
  readonly bot: Bot;
  readonly ctx: ActionContext;
  readonly deps: ProcureDeps;
  readonly abort = new AbortController();

  constructor(readonly world: World, inventory: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(inventory)) this.inv.set(k, v);
    const self = this;
    this.bot = {
      registry,
      entity: { position: new Vec3(0, 64, 0) },
      inventory: { items: () => self.items() },
      findBlock: ({ matching }: { matching: number | number[] }) => {
        const ids = Array.isArray(matching) ? matching : [matching];
        const names = ids.map((id) => registry.blocks[id]?.name);
        if (names.includes('crafting_table') && self.world.tableNearby) return { name: 'crafting_table' };
        if (names.some((n) => n === 'furnace') && self.world.furnaceNearby) return { name: 'furnace' };
        return null;
      },
      nearestEntity: (pred: (e: FakeEntity) => boolean) => self.world.entities.find(pred) ?? null,
      entities: {},
    } as unknown as Bot;
    this.ctx = {
      bot: this.bot,
      // the simulated retina sees whatever exists in the world
      observer: { getLastScan: () => ({ visible: Object.entries(self.world.blocks).filter(([, n]) => n > 0).map(([name]) => ({ name })) }) } as unknown as ActionContext['observer'],
      signal: this.abort.signal,
      log: { info() {}, warn() {}, debug() {}, error() {} } as unknown as ActionContext['log'],
      progress: () => undefined,
    };
    this.deps = {
      runSub: async <T>(_ctx: ActionContext, name: string, args: Record<string, unknown>) => (await self.run(name, args)) as T,
      ensureCraftingTable: async () => {
        if (self.world.tableNearby) return;
        if (!self.take('crafting_table', 1)) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no crafting table to place');
        self.world.tableNearby = true;
      },
    };
  }

  items() {
    return [...this.inv.entries()].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: registry.itemsByName[name]?.id ?? 0 }));
  }

  count(name: string): number {
    return this.inv.get(name) ?? 0;
  }

  add(name: string, n: number): void {
    this.inv.set(name, (this.inv.get(name) ?? 0) + n);
  }

  take(name: string, n: number): boolean {
    if (this.count(name) < n) return false;
    this.inv.set(name, this.count(name) - n);
    return true;
  }

  private hasToolFor(block: string): boolean {
    const def = registry.blocksByName[block] as { harvestTools?: Record<string, boolean> } | undefined;
    if (!def?.harvestTools) return true;
    return Object.keys(def.harvestTools).some((id) => this.count(registry.items[Number(id)]?.name ?? '') > 0);
  }

  private async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push(`${name} ${JSON.stringify(args)}`);
    switch (name) {
      case 'mine': {
        const names = resolveBlockNames(this.bot, String(args['name']));
        const block = names.find((n) => (this.world.blocks[n] ?? 0) > 0);
        if (!block) throw new BodyError(ErrorCodes.NOT_FOUND, `no ${String(args['name'])} nearby`);
        if (!this.hasToolFor(block)) throw new BodyError(ErrorCodes.MISSING_TOOL, `mining ${block} requires a better tool`);
        const want = Number(args['count'] ?? 1);
        const mined = Math.min(want, this.world.blocks[block] ?? 0);
        this.world.blocks[block] = (this.world.blocks[block] ?? 0) - mined;
        const delta: Record<string, number> = {};
        const override = this.world.dropOverride?.[block];
        if (override) {
          for (const [item, n] of Object.entries(override)) {
            this.add(item, n * mined);
            if (n) delta[item] = n * mined;
          }
        } else {
          const loot = (registry as unknown as { blockLoot: Record<string, { drops: { item: string; silkTouch?: boolean }[] }> }).blockLoot[block];
          const drop = loot?.drops.find((d) => !d.silkTouch)?.item ?? block;
          this.add(drop, mined);
          delta[drop] = mined;
        }
        return { requested: want, mined, inventoryDelta: delta };
      }
      case 'craft': {
        const item = String(args['name']);
        const want = Number(args['count'] ?? 1);
        const id = registry.itemsByName[item]?.id;
        if (id === undefined) throw new BodyError(ErrorCodes.NOT_FOUND, `unknown item ${item}`);
        const recipes = Recipe.find(id, null);
        const usable = recipes.find((r) => r.delta.filter((d) => d.count < 0).every((d) => this.count(registry.items[d.id]?.name ?? '') >= -d.count));
        if (!usable) throw new BodyError(ErrorCodes.MISSING_ITEM, `cannot craft ${item}: missing ingredients`);
        if (usable.requiresTable && !this.world.tableNearby) throw new BodyError(ErrorCodes.MISSING_ITEM, `cannot craft ${item}: no crafting table`);
        let crafted = 0;
        while (crafted < want) {
          const ok = usable.delta.filter((d) => d.count < 0).every((d) => this.count(registry.items[d.id]?.name ?? '') >= -d.count);
          if (!ok) break;
          for (const d of usable.delta) this.add(registry.items[d.id]?.name ?? '', d.count);
          crafted += usable.result.count;
        }
        if (crafted === 0) throw new BodyError(ErrorCodes.MISSING_ITEM, `cannot craft ${item}`);
        return { item, crafted, usedTable: usable.requiresTable, inventoryDelta: {} };
      }
      case 'smelt': {
        const input = String(args['name']);
        const want = Number(args['count'] ?? 1);
        if (!this.world.furnaceNearby) {
          if (!this.take('furnace', 1)) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no furnace nearby and none in inventory');
          this.world.furnaceNearby = true;
        }
        const output = Object.entries(SMELTING).find(([, from]) => from === input || (from === 'any_log' && input.endsWith('_log')))?.[0];
        if (!output) throw new BodyError(ErrorCodes.NOT_FOUND, `${input} cannot be smelted`);
        const n = Math.min(want, this.count(input));
        if (n === 0) throw new BodyError(ErrorCodes.MISSING_ITEM, `no ${input} to smelt`);
        const fuel = this.count('coal') > 0 ? 'coal' : [...this.inv.keys()].find((k) => k.endsWith('_log') || k.endsWith('_planks'));
        if (!fuel) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no fuel');
        this.take(fuel, 1);
        this.take(input, n);
        this.add(output, n);
        return { input, smelted: n, fuel: { name: fuel, count: 1 }, inventoryDelta: {} };
      }
      case 'explore': {
        this.world.onExplore?.(this.world);
        return { found: null, travelled: 20 };
      }
      case 'attack': {
        const id = Number(args['id']);
        const idx = this.world.entities.findIndex((e) => e.id === id);
        if (idx < 0) throw new BodyError(ErrorCodes.NOT_FOUND, `no entity ${id}`);
        const [dead] = this.world.entities.splice(idx, 1);
        for (const [item, n] of Object.entries(dead?.drops ?? {})) this.add(item, n);
        return { target: dead?.name, killed: true };
      }
      case 'collect_items':
        return { approached: 0, inventoryDelta: {} };
      default:
        throw new Error(`unexpected primitive in simulation: ${name}`);
    }
  }
}

const forest = (): World => ({ blocks: { oak_log: 40, stone: 200, iron_ore: 12, coal_ore: 10, gravel: 20 }, entities: [], tableNearby: false, furnaceNearby: false });

describe('get: plan → act → re-plan loop', () => {
  it('turns nothing into sticks: mine logs, craft planks, craft sticks', async () => {
    const sim = new Sim(forest());
    const res = await runGet(sim.ctx, { name: 'stick', count: 4, maxSteps: 10 }, sim.deps);
    expect(res.done).toBe(true);
    expect(res.have).toBeGreaterThanOrEqual(4);
    expect(res.steps).toBe(3);
    expect(res.executed.every((l) => l.startsWith('✓'))).toBe(true);
    expect(res.remainingPlan).toBeNull();
    expect(sim.calls[0]).toMatch(/^mine .*oak_log/);
  });

  it('bootstraps a whole tool chain, placing the table and furnace on the way to an iron pickaxe', async () => {
    const sim = new Sim(forest());
    const res = await runGet(sim.ctx, { name: 'iron_pickaxe', count: 1, maxSteps: 30 }, sim.deps);
    expect(res.done).toBe(true);
    expect(sim.world.tableNearby).toBe(true);
    expect(sim.world.furnaceNearby).toBe(true);
    const kinds = res.executed.join('\n');
    expect(kinds).toContain('crafting table ready');
    expect(kinds).toMatch(/crafted \d+ stone_pickaxe/); // stone before iron (iron ore needs stone tier)
    expect(kinds).toMatch(/smelted 3 iron_ingot from raw_iron/);
    expect(kinds).toMatch(/crafted 1 iron_pickaxe/);
    // resources were really consumed from the world, not conjured
    expect(sim.world.blocks['iron_ore']).toBe(9);
    expect(sim.count('iron_pickaxe')).toBe(1);
  });

  it('is incremental: with the ingredients in hand it crafts in a single step', async () => {
    const sim = new Sim({ ...forest(), tableNearby: true }, { iron_ingot: 3, stick: 2 });
    const res = await runGet(sim.ctx, { name: 'iron_pickaxe', count: 1, maxSteps: 5 }, sim.deps);
    expect(res.steps).toBe(1);
    expect(res.executed).toEqual(['✓ crafted 1 iron_pickaxe']);
  });

  it('uses the wood species it can actually see instead of assuming oak', async () => {
    const world = forest();
    world.blocks['oak_log'] = 0;
    world.blocks['birch_log'] = 10;
    const sim = new Sim(world);
    const res = await runGet(sim.ctx, { name: 'stick', count: 4, maxSteps: 10 }, sim.deps);
    expect(res.done).toBe(true);
    expect(sim.calls.some((c) => c.startsWith('explore'))).toBe(false);
    expect(res.executed[0]).toMatch(/mined 1 birch_log/);
    expect(sim.count('birch_planks')).toBe(2);
  });

  it('gives up with the remaining plan when exploring never reveals the source', async () => {
    const world = forest();
    world.blocks['oak_log'] = 0;
    const sim = new Sim(world);
    await expect(runGet(sim.ctx, { name: 'oak_planks', count: 4, maxSteps: 10 }, sim.deps)).rejects.toMatchObject({
      code: ErrorCodes.MISSING_ITEM,
      data: expect.objectContaining({ remainingPlan: expect.stringContaining('oak_log') }),
    });
    expect(sim.calls.filter((c) => c.startsWith('explore')).length).toBe(2);
  });

  it('resumes after exploration reveals the wanted block', async () => {
    const world = forest();
    world.blocks['oak_log'] = 0;
    world.onExplore = (w) => {
      w.blocks['oak_log'] = 10;
    };
    const sim = new Sim(world);
    const res = await runGet(sim.ctx, { name: 'oak_planks', count: 4, maxSteps: 10 }, sim.deps);
    expect(res.done).toBe(true);
    expect(res.executed[0]).toMatch(/explored/);
    expect(res.executed[1]).toMatch(/mined 1 oak_log/);
  });

  it('blocks on hunting when no suitable mob is around, and hunts when one is', async () => {
    const empty = new Sim({ ...forest(), tableNearby: true }, { stick: 3 });
    await expect(runGet(empty.ctx, { name: 'bow', count: 1, maxSteps: 10 }, empty.deps)).rejects.toMatchObject({
      code: ErrorCodes.MISSING_ITEM,
      message: expect.stringContaining('no spider/cave_spider within'),
    });
    const spiders = new Sim({ ...forest(), tableNearby: true, entities: [1, 2, 3].map((id) => ({ id, name: 'spider', position: new Vec3(5 * id, 64, 0), drops: { string: 1 } })) }, { stick: 3 });
    const res = await runGet(spiders.ctx, { name: 'bow', count: 1, maxSteps: 10 }, spiders.deps);
    expect(res.done).toBe(true);
    expect(res.executed.filter((l) => l.includes('killed a spider')).length).toBe(3);
    expect(spiders.world.entities).toEqual([]);
  });

  it('ignores mobs that are too far away to be worth a chase', async () => {
    const sim = new Sim({ ...forest(), tableNearby: true, entities: [{ id: 9, name: 'spider', position: new Vec3(300, 64, 0), drops: { string: 1 } }] }, { stick: 3 });
    await expect(runGet(sim.ctx, { name: 'bow', count: 1, maxSteps: 10 }, sim.deps)).rejects.toMatchObject({ code: ErrorCodes.MISSING_ITEM });
    expect(sim.world.entities).toHaveLength(1);
  });

  it('detects a stalled step (mining that never yields the drop) instead of looping', async () => {
    const world = forest();
    world.dropOverride = { gravel: { gravel: 1 } }; // unlucky: never flint
    const sim = new Sim(world);
    await expect(runGet(sim.ctx, { name: 'flint', count: 1, maxSteps: 20 }, sim.deps)).rejects.toMatchObject({
      code: ErrorCodes.MISSING_ITEM,
      message: expect.stringContaining('failed 2 times in a row'),
    });
    expect(sim.calls.filter((c) => c.startsWith('mine')).length).toBe(2);
  });

  it('reports what cannot be obtained automatically', async () => {
    const sim = new Sim(forest());
    await expect(runGet(sim.ctx, { name: 'dragon_egg', count: 1, maxSteps: 5 }, sim.deps)).rejects.toMatchObject({
      code: ErrorCodes.MISSING_ITEM,
      message: expect.stringContaining('dragon_egg'),
    });
    expect(sim.calls).toEqual([]);
    await expect(runGet(sim.ctx, { name: 'not_a_thing', count: 1, maxSteps: 5 }, sim.deps)).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });

  it('respects the step budget', async () => {
    const sim = new Sim(forest());
    await expect(runGet(sim.ctx, { name: 'wooden_pickaxe', count: 1, maxSteps: 2 }, sim.deps)).rejects.toMatchObject({
      code: ErrorCodes.TIMEOUT,
      data: expect.objectContaining({ executed: expect.any(Array), remainingPlan: expect.stringContaining('wooden_pickaxe') }),
    });
  });

  it('propagates interruption immediately', async () => {
    const sim = new Sim(forest());
    sim.abort.abort('reflex: flee');
    await expect(runGet(sim.ctx, { name: 'stick', count: 1, maxSteps: 5 }, sim.deps)).rejects.toMatchObject({ code: ErrorCodes.INTERRUPTED });
    expect(sim.calls).toEqual([]);
  });

  it('fetches fuel before smelting when the inventory has none', async () => {
    const sim = new Sim({ ...forest(), furnaceNearby: true }, { raw_iron: 2, stone_pickaxe: 1 });
    const outcome = await executeStep(sim.ctx, { kind: 'smelt', item: 'iron_ingot', count: 2, sources: ['raw_iron'], fuel: true }, new Map(), sim.deps);
    expect(outcome.ok).toBe(true);
    expect(sim.calls[0]).toMatch(/^mine .*coal_ore/);
    expect(sim.count('iron_ingot')).toBe(2);
  });

  it('plans from what the body actually has around it', () => {
    const sim = new Sim({ ...forest(), tableNearby: true, furnaceNearby: true }, { raw_iron: 3, coal: 2, stick: 2 });
    const plan = plannerFor(sim.ctx).plan('iron_pickaxe', 1);
    expect(plan.steps.map((s) => `${s.kind}:${s.item}`)).toEqual(['smelt:iron_ingot', 'craft:iron_pickaxe']);
  });
});
