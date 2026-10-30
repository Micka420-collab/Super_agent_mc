/**
 * Block placement helpers — the fiddly part of being a Minecraft player.
 */
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Vec3Like } from '../protocol.js';
import { BodyError, ErrorCodes } from '../protocol.js';
import { raceAbort, sleep } from '../util/async.js';
import { distance } from '../util/geometry.js';
import { findItem } from './items.js';
import { goTo } from './movement.js';

const { goals } = pathfinderPkg;

const FACES: Vec3[] = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/** Blocks that cannot be used as a placement reference / are replaced by placing. */
const NON_SOLID = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'seagrass', 'kelp', 'vine', 'light']);

export function isReplaceable(block: Block | null): boolean {
  return !block || NON_SOLID.has(block.name) || block.boundingBox === 'empty';
}

/** Find a solid neighbour of `pos` to click on, and the face vector pointing from it to `pos`. */
export function findReference(bot: Bot, pos: Vec3): { reference: Block; face: Vec3 } | null {
  // prefer the block below (most natural), then sides, then above
  const order = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];
  for (const d of order) {
    const ref = bot.blockAt(pos.plus(d));
    if (ref && !isReplaceable(ref) && ref.boundingBox === 'block') {
      return { reference: ref, face: d.scaled(-1) };
    }
  }
  return null;
}

/** Is the bot's own body occupying the target cell? */
export function occupiesCell(bot: Bot, pos: Vec3): boolean {
  const p = bot.entity.position;
  const feet = p.floored();
  const head = feet.offset(0, 1, 0);
  return feet.equals(pos) || head.equals(pos);
}

export interface PlaceResult {
  placed: boolean;
  position: Vec3Like;
  block: string;
  reason?: string;
}

/**
 * Place `itemName` at `pos`. Walks into a position from which the reference block is reachable,
 * sneaks to avoid activating containers, and verifies the result.
 */
export async function placeBlockAt(bot: Bot, itemName: string, pos: Vec3Like, signal?: AbortSignal): Promise<PlaceResult> {
  const target = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  const existing = bot.blockAt(target);
  if (existing && existing.name === itemName) return { placed: false, position: target, block: existing.name, reason: 'already there' };
  if (!isReplaceable(existing)) {
    throw new BodyError(ErrorCodes.BAD_REQUEST, `cannot place ${itemName} at ${target}: occupied by ${existing?.name}`);
  }
  const item = findItem(bot, itemName);
  if (!item) throw new BodyError(ErrorCodes.MISSING_ITEM, `I don't have any ${itemName}`);

  let ref = findReference(bot, target);
  if (!ref) throw new BodyError(ErrorCodes.BAD_REQUEST, `no solid block next to ${target} to place against`);

  // Move so the reference face is within reach and we are not standing in the target cell.
  if (occupiesCell(bot, target) || distance(bot.entity.position.offset(0, 1.6, 0), target.offset(0.5, 0.5, 0.5)) > 4.5) {
    const goal = new goals.GoalPlaceBlock(target, bot.world as never, { range: 4, faces: FACES, facing: 'down', half: 'top', LOS: true } as never);
    try {
      await raceAbort(bot.pathfinder.goto(goal), signal, { timeoutMs: 30_000, onCancel: () => bot.pathfinder.stop() });
    } catch {
      // fall back: stand 2 blocks away in any direction
      await goTo(bot, { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }, 2.5, signal, { timeoutMs: 30_000 });
    }
    ref = findReference(bot, target) ?? ref;
  }
  if (occupiesCell(bot, target)) {
    // step aside
    const side = target.offset(1.5, 0, 0.5);
    await goTo(bot, side, 0.6, signal, { timeoutMs: 10_000 });
  }

  await bot.equip(item, 'hand');
  bot.setControlState('sneak', true);
  try {
    await bot.lookAt(ref.reference.position.offset(0.5, 0.5, 0.5).plus(ref.face.scaled(0.5)), true);
    await raceAbort(bot.placeBlock(ref.reference, ref.face), signal, { timeoutMs: 8_000 });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Mineflayer throws when the server didn't update the block quickly enough; verify before failing.
    await sleep(150, signal);
    const after = bot.blockAt(target);
    if (!after || isReplaceable(after)) throw new BodyError(ErrorCodes.INTERNAL, `placement failed: ${msg}`);
  } finally {
    bot.setControlState('sneak', false);
  }
  await sleep(100, signal);
  const after = bot.blockAt(target);
  const ok = !!after && !isReplaceable(after);
  return { placed: ok, position: target, block: after?.name ?? 'air', ...(ok ? {} : { reason: 'block did not appear' }) };
}

/** Find a free spot on the ground near the bot where a utility block (table, furnace) can go. */
export function findPlacementSpotNear(bot: Bot, maxRadius = 3): Vec3 | null {
  const base = bot.entity.position.floored();
  for (let r = 1; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        for (const dy of [0, -1, 1]) {
          const pos = base.offset(dx, dy, dz);
          const here = bot.blockAt(pos);
          const below = bot.blockAt(pos.offset(0, -1, 0));
          const above = bot.blockAt(pos.offset(0, 1, 0));
          if (isReplaceable(here) && below && !isReplaceable(below) && below.boundingBox === 'block' && isReplaceable(above)) {
            return pos;
          }
        }
      }
    }
  }
  return null;
}
