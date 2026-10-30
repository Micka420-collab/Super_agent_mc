/**
 * Procurement primitives — the deterministic "get me X" layer.
 *
 * `plan_get` is a pure dry run over the recipe/loot tables (no LLM, no movement). `get` executes
 * that plan one step at a time and re-plans from the live inventory after every step, so partial
 * failures (a mob that fled, a vein that was smaller than hoped) are absorbed instead of derailing
 * the whole chain. The body stays honest: every step is an ordinary primitive (mine / craft /
 * smelt / attack / explore) running under the same abort signal and reflex preemption.
 */
import { z } from 'zod';
import { BodyError, ErrorCodes } from '../protocol.js';
import { countItem, inventorySummary, normalizeName, resolveItemNames } from '../motor/items.js';
import { ProcurementPlanner, describePlan, type Plan, type PlanStep } from '../motor/procurement.js';
import { throwIfAborted } from '../util/async.js';
import { distance } from '../util/geometry.js';
import { ensureCraftingTable, chooseFuel } from './crafting.js';
import { defineAction, getAction, parseArgs, type ActionContext } from './registry.js';

const UTILITY_SEARCH_RADIUS = 24;
const MINE_SEARCH_RADIUS = 48;
const HUNT_RADIUS = 40;
/** How many times a mine step may come back empty-handed (with an exploration in between) before giving up. */
const MAX_EXPLORATIONS = 2;
/** How many consecutive failures of the very same step are tolerated before the whole `get` stops. */
const MAX_STEP_RETRIES = 2;

export interface StepOutcome {
  ok: boolean;
  detail: string;
  /** The step cannot succeed without outside help (missing tool tier, unknown source, nothing in range). */
  blocked?: boolean;
}

function resolveTarget(ctx: ActionContext, name: string): string {
  const candidates = resolveItemNames(ctx.bot, name);
  const exact = normalizeName(name);
  const resolved = candidates.includes(exact) ? exact : candidates[0];
  if (!resolved) throw new BodyError(ErrorCodes.NOT_FOUND, `unknown item: ${name}`);
  return resolved;
}

/** Build a planner from what the body can honestly see: inventory, nearby utility blocks, blocks in view. */
export function plannerFor(ctx: ActionContext): ProcurementPlanner {
  const bot = ctx.bot;
  const inventory: Record<string, number> = {};
  for (const i of inventorySummary(bot)) inventory[i.name] = (inventory[i.name] ?? 0) + i.count;
  const tableId = bot.registry.blocksByName['crafting_table']?.id;
  const furnaceIds = ['furnace', 'blast_furnace', 'smoker'].map((n) => bot.registry.blocksByName[n]?.id).filter((x): x is number => x !== undefined);
  const seen = ctx.observer.getLastScan()?.visible.map((b) => b.name) ?? [];
  return new ProcurementPlanner({
    registry: bot.registry,
    inventory,
    knownBlocks: new Set(seen),
    hasCraftingTableNearby: tableId !== undefined && !!bot.findBlock({ matching: tableId, maxDistance: UTILITY_SEARCH_RADIUS }),
    hasFurnaceNearby: furnaceIds.length > 0 && !!bot.findBlock({ matching: furnaceIds, maxDistance: UTILITY_SEARCH_RADIUS }),
  });
}

defineAction({
  name: 'plan_get',
  category: 'crafting',
  description:
    'Dry run: the dependency plan (mine → craft → smelt → hunt) to obtain an item, computed from the current inventory and what is nearby. Costs nothing — use it to judge whether a goal is realistic before committing to `get`.',
  longRunning: false,
  schema: z.object({
    name: z.string().describe('item to obtain, e.g. "stone_pickaxe", "torch", "white_bed"'),
    count: z.number().int().min(1).max(256).default(1),
  }),
  async run(ctx, a) {
    const target = resolveTarget(ctx, a.name);
    const plan = plannerFor(ctx).plan(target, a.count);
    return { ...plan, feasible: plan.unresolved.length === 0, text: describePlan(plan) };
  },
});

/** Side-effecting collaborators of `get`, injectable so the control loop can be unit-tested against a simulated world. */
export interface ProcureDeps {
  /** Run another registered primitive with validated arguments. */
  runSub: <T>(ctx: ActionContext, name: string, args: Record<string, unknown>) => Promise<T>;
  ensureCraftingTable: (ctx: ActionContext) => Promise<unknown>;
}

export const defaultDeps: ProcureDeps = {
  async runSub<T>(ctx: ActionContext, name: string, args: Record<string, unknown>): Promise<T> {
    const def = getAction(name);
    return (await def.run(ctx, parseArgs(def, args))) as T;
  },
  ensureCraftingTable: (ctx) => ensureCraftingTable(ctx),
};

function isCode(err: unknown, code: (typeof ErrorCodes)[keyof typeof ErrorCodes]): boolean {
  return err instanceof BodyError && err.code === code;
}

/** Make sure there is fuel for `items` items; mines coal (needs a pickaxe) or logs when there is none. */
async function ensureFuel(ctx: ActionContext, items: number, deps: ProcureDeps): Promise<void> {
  if (chooseFuel(ctx, items)) return;
  ctx.progress('no fuel in inventory, fetching some');
  try {
    await deps.runSub(ctx, 'mine', { name: 'coal_ore', count: Math.max(1, Math.ceil(items / 8)), maxDistance: 32 });
    if (chooseFuel(ctx, items)) return;
  } catch (err) {
    if (isCode(err, ErrorCodes.INTERRUPTED)) throw err;
  }
  await deps.runSub(ctx, 'mine', { name: 'log', count: Math.max(2, Math.ceil(items / 1.5)), maxDistance: MINE_SEARCH_RADIUS });
}

export async function executeStep(ctx: ActionContext, step: PlanStep, explorations: Map<string, number>, deps: ProcureDeps = defaultDeps): Promise<StepOutcome> {
  const bot = ctx.bot;
  switch (step.kind) {
    case 'place_table': {
      await deps.ensureCraftingTable(ctx);
      return { ok: true, detail: 'crafting table ready' };
    }
    case 'craft': {
      const res = await deps.runSub<{ crafted: number }>(ctx, 'craft', { name: step.item, count: Math.min(step.count, 256) });
      return { ok: res.crafted > 0, detail: `crafted ${res.crafted} ${step.item}` };
    }
    case 'smelt': {
      const input = step.sources?.[0] ?? step.item;
      const inputName = input === 'any_log' ? (bot.inventory.items().find((i) => i.name.endsWith('_log'))?.name ?? 'oak_log') : input;
      await ensureFuel(ctx, step.count, deps);
      const res = await deps.runSub<{ smelted: number }>(ctx, 'smelt', { name: inputName, count: Math.min(step.count, 64) });
      return { ok: res.smelted > 0, detail: `smelted ${res.smelted} ${step.item} from ${inputName}` };
    }
    case 'mine': {
      // "any_log" is the planner's wildcard; the mine primitive understands the fuzzy "log" directly.
      const sources = step.item === 'any_log' ? ['log'] : (step.sources ?? [step.item]);
      for (const source of sources) {
        throwIfAborted(ctx.signal);
        try {
          const res = await deps.runSub<{ mined: number; inventoryDelta: Record<string, number> }>(ctx, 'mine', { name: source, count: Math.min(step.count, 256), maxDistance: MINE_SEARCH_RADIUS });
          const gained = step.item === 'any_log' ? res.mined : (res.inventoryDelta[step.item] ?? 0);
          if (gained > 0) return { ok: true, detail: `mined ${gained} ${step.item} from ${source}` };
          if (res.mined > 0) return { ok: false, detail: `mined ${res.mined} ${source} but got no ${step.item} (bad luck or the drop did not reach me)` };
        } catch (err) {
          if (isCode(err, ErrorCodes.NOT_FOUND)) continue;
          if (isCode(err, ErrorCodes.MISSING_TOOL)) return { ok: false, detail: (err as Error).message, blocked: true };
          throw err;
        }
      }
      // Nothing in range: explore once towards fresh terrain; the next planning round retries.
      const tries = (explorations.get(step.item) ?? 0) + 1;
      explorations.set(step.item, tries);
      if (tries > MAX_EXPLORATIONS) return { ok: false, detail: `cannot find ${sources.join('/')} nearby even after exploring`, blocked: true };
      ctx.progress(`no ${step.item} source nearby, exploring (${tries}/${MAX_EXPLORATIONS})`);
      const found = await deps.runSub<{ found: unknown }>(ctx, 'explore', { direction: 'random', maxSeconds: 40, lookFor: step.item === 'any_log' ? ['oak_log', 'birch_log', 'spruce_log'] : sources });
      return { ok: true, detail: found.found ? `explored and spotted a source of ${step.item}` : `explored looking for ${sources.join('/')}` };
    }
    case 'hunt': {
      const sources = step.sources ?? [];
      const wanted = new Set(sources);
      const target = bot.nearestEntity((e) => !!e.name && wanted.has(e.name) && distance(e.position, bot.entity.position) <= HUNT_RADIUS);
      if (!target) return { ok: false, detail: `no ${sources.join('/')} within ${HUNT_RADIUS} blocks to get ${step.item}`, blocked: true };
      const before = countItem(bot, step.item);
      const res = await deps.runSub<{ killed: boolean }>(ctx, 'attack', { id: target.id, timeoutMs: 45_000 });
      await deps.runSub(ctx, 'collect_items', { radius: 10, maxItems: 6 });
      const gained = countItem(bot, step.item) - before;
      return { ok: gained > 0, detail: `${res.killed ? 'killed' : 'fought'} a ${target.name} — ${gained > 0 ? `+${gained} ${step.item}` : `no ${step.item} dropped`}` };
    }
    case 'shear': {
      const before = countItem(bot, step.item);
      try {
        const res = await deps.runSub<{ sheared: number; wool: number }>(ctx, 'shear', { count: Math.min(step.count, 64), color: step.item, maxDistance: HUNT_RADIUS });
        const gained = countItem(bot, step.item) - before;
        return { ok: gained > 0, detail: `sheared ${res.sheared} sheep for ${gained} ${step.item}` };
      } catch (err) {
        if (isCode(err, ErrorCodes.NOT_FOUND)) return { ok: false, detail: (err as Error).message, blocked: true };
        throw err;
      }
    }
    case 'acquire':
      return { ok: false, detail: `${step.item}: ${step.note ?? 'cannot be obtained automatically'}`, blocked: true };
  }
}

export interface GetArgs {
  name: string;
  count: number;
  maxSteps: number;
}

export interface GetResult {
  item: string;
  requested: number;
  have: number;
  done: boolean;
  steps: number;
  executed: string[];
  remainingPlan: string | null;
}

/** The `get` control loop: plan → execute first step → re-plan, until done, blocked or out of budget. */
export async function runGet(ctx: ActionContext, a: GetArgs, deps: ProcureDeps = defaultDeps): Promise<GetResult> {
  const target = resolveTarget(ctx, a.name);
  const executed: string[] = [];
  const explorations = new Map<string, number>();
  const failures = new Map<string, number>();
  let blocked: string | null = null;
  let plan: Plan = plannerFor(ctx).plan(target, a.count);
  let steps = 0;

  while (steps < a.maxSteps && plan.steps.length > 0) {
    throwIfAborted(ctx.signal);
    const step = plan.steps[0] as PlanStep;
    const key = `${step.kind}:${step.item}`;
    ctx.progress(`get ${target}: ${step.kind} ${step.count} ${step.item} (${plan.steps.length} step${plan.steps.length > 1 ? 's' : ''} left)`, { step, remaining: plan.steps.length });
    steps += 1;
    let outcome: StepOutcome;
    try {
      outcome = await executeStep(ctx, step, explorations, deps);
    } catch (err) {
      if (isCode(err, ErrorCodes.INTERRUPTED)) throw err;
      outcome = { ok: false, detail: `${step.kind} ${step.item} failed: ${(err as Error).message}` };
    }
    executed.push(`${outcome.ok ? '✓' : '✗'} ${outcome.detail}`);
    if (outcome.blocked) {
      blocked = outcome.detail;
      break;
    }
    const consecutive = outcome.ok ? 0 : (failures.get(key) ?? 0) + 1;
    failures.set(key, consecutive);
    if (consecutive >= MAX_STEP_RETRIES) {
      blocked = `${key} failed ${consecutive} times in a row: ${outcome.detail}`;
      break;
    }
    plan = plannerFor(ctx).plan(target, a.count);
  }

  const have = countItem(ctx.bot, target);
  const done = have >= a.count;
  const remainingPlan = done ? null : describePlan(plan);
  if (!done && blocked) {
    throw new BodyError(ErrorCodes.MISSING_ITEM, `could not get ${a.count} ${target}: ${blocked}`, { have, executed, remainingPlan });
  }
  if (!done && steps >= a.maxSteps) {
    throw new BodyError(ErrorCodes.TIMEOUT, `gave up on ${target} after ${steps} steps (have ${have}/${a.count})`, { have, executed, remainingPlan });
  }
  return { item: target, requested: a.count, have, done, steps, executed, remainingPlan };
}

defineAction({
  name: 'get',
  category: 'crafting',
  description:
    'Obtain an item by executing its whole dependency tree — mine, craft, smelt, hunt nearby mobs, place a crafting table — replanning from the real inventory after every step. Stops and reports (MISSING_ITEM with the remaining plan) when a step needs something it cannot do alone.',
  longRunning: true,
  schema: z.object({
    name: z.string().describe('item to obtain, e.g. "stone_pickaxe", "torch", "iron_ingot"'),
    count: z.number().int().min(1).max(256).default(1),
    maxSteps: z.number().int().min(1).max(60).default(24).describe('safety bound on executed steps'),
  }),
  run: (ctx, a) => runGet(ctx, a),
});

