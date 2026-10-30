/**
 * Movement helpers on top of mineflayer-pathfinder, with cooperative cancellation.
 */
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { Vec3Like } from '../protocol.js';
import { BodyError, ErrorCodes } from '../protocol.js';
import { raceAbort, sleep, waitFor } from '../util/async.js';
import { distance } from '../util/geometry.js';

const { Movements, goals } = pathfinderPkg;

export interface MovementProfile {
  canDig: boolean;
  allowParkour: boolean;
  allowSprinting: boolean;
  allow1by1towers: boolean;
  canOpenDoors: boolean;
  /** Blocks the bot must never break while pathing (player builds, ores it wants to mine itself, ...). */
  protectedBlocks: string[];
  scaffoldingBlocks: string[];
}

export const DEFAULT_PROFILE: MovementProfile = {
  canDig: true,
  allowParkour: true,
  allowSprinting: true,
  allow1by1towers: true,
  canOpenDoors: false,
  protectedBlocks: ['chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace', 'bed', 'glass', 'glass_pane'],
  scaffoldingBlocks: ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate', 'stone', 'oak_planks', 'spruce_planks', 'birch_planks'],
};

export const CAREFUL_PROFILE: MovementProfile = {
  ...DEFAULT_PROFILE,
  canDig: false,
  allowParkour: false,
  allow1by1towers: false,
};

/** Build a pathfinder Movements object for a profile. */
export function buildMovements(bot: Bot, profile: MovementProfile = DEFAULT_PROFILE): InstanceType<typeof Movements> {
  const m = new Movements(bot);
  m.canDig = profile.canDig;
  m.allowParkour = profile.allowParkour;
  m.allowSprinting = profile.allowSprinting;
  m.allow1by1towers = profile.allow1by1towers;
  m.canOpenDoors = profile.canOpenDoors;
  m.allowFreeMotion = false;
  for (const name of profile.protectedBlocks) {
    const def = bot.registry.blocksByName[name];
    if (def) m.blocksCantBreak.add(def.id);
  }
  // mineflayer-pathfinder types declare scafoldingBlocks as number[] (item ids)
  m.scafoldingBlocks = profile.scaffoldingBlocks
    .map((n) => bot.registry.itemsByName[n]?.id)
    .filter((id): id is number => typeof id === 'number');
  return m;
}

function mapPathError(err: unknown): BodyError {
  const e = err as { name?: string; message?: string };
  switch (e?.name) {
    case 'NoPath':
      return new BodyError(ErrorCodes.NO_PATH, 'no path to the goal');
    case 'Timeout':
      return new BodyError(ErrorCodes.TIMEOUT, 'pathfinding took too long');
    case 'GoalChanged':
      return new BodyError(ErrorCodes.INTERRUPTED, 'goal changed');
    case 'PathStopped':
      return new BodyError(ErrorCodes.INTERRUPTED, 'path stopped');
    default:
      return err instanceof BodyError ? err : new BodyError(ErrorCodes.INTERNAL, e?.message ?? String(err));
  }
}

/** Walk until within `range` blocks of the target position. */
export async function goTo(
  bot: Bot,
  target: Vec3Like,
  range = 1,
  signal?: AbortSignal,
  opts: { timeoutMs?: number; profile?: MovementProfile } = {},
): Promise<void> {
  if (distance(bot.entity.position, target) <= range + 0.3) return;
  if (opts.profile) bot.pathfinder.setMovements(buildMovements(bot, opts.profile));
  const goal = new goals.GoalNear(target.x, target.y, target.z, range);
  try {
    await raceAbort(bot.pathfinder.goto(goal), signal, {
      timeoutMs: opts.timeoutMs ?? 60_000,
      onCancel: () => bot.pathfinder.stop(),
      timeoutMessage: 'took too long to reach the destination',
    });
  } catch (err) {
    throw mapPathError(err);
  }
}

/** Stand next to (not inside) a block so it can be interacted with. */
export async function goToBlock(bot: Bot, pos: Vec3Like, signal?: AbortSignal, timeoutMs = 60_000): Promise<void> {
  if (distance(bot.entity.position, { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5 }) <= 3.2) return;
  const goal = new goals.GoalGetToBlock(pos.x, pos.y, pos.z);
  try {
    await raceAbort(bot.pathfinder.goto(goal), signal, { timeoutMs, onCancel: () => bot.pathfinder.stop() });
  } catch (err) {
    // fall back to a looser goal — GoalGetToBlock can be impossible for blocks embedded in walls
    const e = err as { name?: string };
    if (e?.name === 'NoPath') {
      await goTo(bot, { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5 }, 3, signal, { timeoutMs });
      return;
    }
    throw mapPathError(err);
  }
}

/**
 * Follow an entity until within `range`, re-planning as it moves. Resolves once in range
 * (or when `keepFollowing` is false and the entity vanished).
 */
export async function approachEntity(bot: Bot, entity: Entity, range = 2, signal?: AbortSignal, timeoutMs = 60_000): Promise<void> {
  const goal = new goals.GoalFollow(entity, range);
  bot.pathfinder.setGoal(goal, true);
  try {
    await waitFor(() => !bot.entities[entity.id] || distance(bot.entity.position, entity.position) <= range + 0.5, {
      timeoutMs,
      intervalMs: 100,
      signal,
      message: 'could not reach the entity in time',
    });
  } finally {
    bot.pathfinder.setGoal(null);
  }
  if (!bot.entities[entity.id]) throw new BodyError(ErrorCodes.NOT_FOUND, 'the entity disappeared');
}

/** Keep following until the signal aborts. */
export async function followEntity(bot: Bot, entity: Entity, range = 3, signal?: AbortSignal): Promise<void> {
  const goal = new goals.GoalFollow(entity, range);
  bot.pathfinder.setGoal(goal, true);
  try {
    while (!signal?.aborted) {
      if (!bot.entities[entity.id]) throw new BodyError(ErrorCodes.NOT_FOUND, 'lost the entity I was following');
      await sleep(250, signal);
    }
  } catch (err) {
    if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) return;
    throw err;
  } finally {
    bot.pathfinder.setGoal(null);
  }
}

/** Run away from a position until at least `minDistance` away. */
export async function fleeFrom(bot: Bot, threat: Vec3Like, minDistance = 16, signal?: AbortSignal, timeoutMs = 20_000): Promise<void> {
  const inner = new goals.GoalNear(threat.x, threat.y, threat.z, minDistance);
  const goal = new goals.GoalInvert(inner);
  bot.pathfinder.setMovements(buildMovements(bot, { ...DEFAULT_PROFILE, canDig: false }));
  bot.pathfinder.setGoal(goal, true);
  try {
    await waitFor(() => distance(bot.entity.position, threat) >= minDistance, { timeoutMs, intervalMs: 100, signal, message: 'could not get away in time' });
  } finally {
    bot.pathfinder.setGoal(null);
    bot.pathfinder.setMovements(buildMovements(bot));
  }
}

/** Fine motor: hold a control for a while. */
export async function holdControl(
  bot: Bot,
  control: 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'sneak',
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  bot.setControlState(control, true);
  try {
    await sleep(ms, signal);
  } finally {
    bot.setControlState(control, false);
  }
}

export function stopAllMovement(bot: Bot): void {
  try {
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
  } catch {
    /* pathfinder may not be loaded yet */
  }
  bot.clearControlStates();
}

export function vec(v: Vec3Like): Vec3 {
  return new Vec3(v.x, v.y, v.z);
}
