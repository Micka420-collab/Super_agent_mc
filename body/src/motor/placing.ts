/**
 * Block placement helpers — the fiddly part of being a Minecraft player.
 */
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import type { Vec3Like } from '../protocol.js';
import { BodyError, ErrorCodes } from '../protocol.js';
import { sleep, waitFor } from '../util/async.js';
import { distance } from '../util/geometry.js';
import { findItem } from './items.js';
import { CAREFUL_PROFILE, goTo, type MovementProfile } from './movement.js';

/** Moving around a construction site: never dig (the pathfinder would happily eat the blocks we just placed). */
export const BUILD_PROFILE: MovementProfile = { ...CAREFUL_PROFILE, canDig: false, allow1by1towers: false, allowParkour: false };

/** Blocks that cannot be used as a placement reference / are replaced by placing. */
const NON_SOLID = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'seagrass', 'kelp', 'vine', 'light']);

export function isReplaceable(block: Block | null): boolean {
  return !block || NON_SOLID.has(block.name) || block.boundingBox === 'empty';
}

/** Same test from a block name alone (for simulations over snapshots). */
export function isReplaceableName(bot: Bot, name: string | null): boolean {
  if (name === null) return false;
  if (NON_SOLID.has(name)) return true;
  const def = bot.registry.blocksByName[name] as { boundingBox?: string } | undefined;
  return def?.boundingBox === 'empty';
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

/**
 * Does the player's hitbox (0.6 × 1.8, centred on the position) overlap the target cell? Servers refuse to place a
 * block inside an entity, and a body standing on a cell boundary straddles two cells — `occupiesCell` misses that.
 */
export function hitboxIntersectsCell(position: Vec3Like, cell: Vec3Like, halfWidth = 0.3, height = 1.8): boolean {
  const minX = position.x - halfWidth;
  const maxX = position.x + halfWidth;
  const minZ = position.z - halfWidth;
  const maxZ = position.z + halfWidth;
  const minY = position.y;
  const maxY = position.y + height;
  const cx = Math.floor(cell.x);
  const cy = Math.floor(cell.y);
  const cz = Math.floor(cell.z);
  return maxX > cx && minX < cx + 1 && maxY > cy && minY < cy + 1 && maxZ > cz && minZ < cz + 1;
}

/**
 * A standing cell near `target` from which it can be placed: two cells away on at least one axis (so the hitbox
 * cannot touch the target even when the body is off-centre), free at feet and head, with a floor under it, and
 * within arm's reach. Nearest to the body first. Integer cell coordinates — pathfinder goals want nodes.
 */
export function standOffSpot(bot: Bot, target: Vec3, maxReach = 4.0): Vec3 | null {
  const me = bot.entity.position;
  const centre = target.offset(0.5, 0.5, 0.5);
  const candidates: Vec3[] = [];
  for (const dx of [-3, -2, -1, 0, 1, 2, 3]) {
    for (const dz of [-3, -2, -1, 0, 1, 2, 3]) {
      if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
      for (const dy of [0, -1, -2, 1, -3, 2]) {
        const cell = target.offset(dx, dy, dz);
        const feet = bot.blockAt(cell);
        const head = bot.blockAt(cell.offset(0, 1, 0));
        const floor = bot.blockAt(cell.offset(0, -1, 0));
        if (!feet || !head || !floor) continue;
        if (!isReplaceable(feet) || !isReplaceable(head) || isReplaceable(floor) || floor.boundingBox !== 'block') continue;
        if (distance(cell.offset(0.5, 1.6, 0.5), centre) > maxReach) continue;
        candidates.push(cell);
      }
    }
  }
  candidates.sort((a, b) => distance(me, a.offset(0.5, 0, 0.5)) - distance(me, b.offset(0.5, 0, 0.5)));
  return candidates[0] ?? null;
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

  // Move so the reference face is within reach and our body is clear of the target cell. Never dig on the way:
  // the pathfinder would otherwise eat the blocks we just placed to reach a standing spot.
  const eyeToTarget = () => distance(bot.entity.position.offset(0, 1.6, 0), target.offset(0.5, 0.5, 0.5));
  const inTheWay = () => occupiesCell(bot, target) || hitboxIntersectsCell(bot.entity.position, target);
  for (let attempt = 0; attempt < 2 && (inTheWay() || eyeToTarget() > 4.2); attempt++) {
    const spot = standOffSpot(bot, target, attempt === 0 ? 4.0 : 5.0);
    if (spot) {
      await goTo(bot, spot, 0.5, signal, { timeoutMs: 20_000, profile: BUILD_PROFILE });
    } else {
      // no proper spot computed (unloaded edges, water…): get within reach along the line from here
      const dir = bot.entity.position.minus(target.offset(0.5, 0, 0.5));
      const horiz = Math.hypot(dir.x, dir.z) || 1;
      await goTo(bot, target.offset(0.5 + (dir.x / horiz) * 2.5, 0, 0.5 + (dir.z / horiz) * 2.5), 1.0, signal, { timeoutMs: 20_000, profile: BUILD_PROFILE });
    }
    await sleep(80, signal);
    ref = findReference(bot, target) ?? ref;
  }
  if (inTheWay()) throw new BodyError(ErrorCodes.NO_PATH, `cannot step clear of ${target} to place ${itemName} there`);
  if (eyeToTarget() > 5.5) throw new BodyError(ErrorCodes.NO_PATH, `cannot get within reach of ${target} without digging`);

  await bot.equip(item, 'hand');
  bot.setControlState('sneak', true);
  try {
    await bot.lookAt(ref.reference.position.offset(0.5, 0.5, 0.5).plus(ref.face.scaled(0.5)), true);
    // Mineflayer waits up to 5 s for the server's block update; local servers can answer before the
    // listener is attached, so we race its promise against our own poll of the target cell.
    const placed = bot.placeBlock(ref.reference, ref.face).then(() => true).catch((err: Error) => err);
    const appeared = waitFor(() => !isReplaceable(bot.blockAt(target)), { timeoutMs: 2_500, intervalMs: 40, signal }).then(() => true).catch(() => false);
    const first = await Promise.race([placed, appeared]);
    if (first instanceof Error) {
      await sleep(150, signal);
      const after = bot.blockAt(target);
      if (!after || isReplaceable(after)) throw new BodyError(ErrorCodes.INTERNAL, `placement failed: ${first.message}`);
    } else if (first === false) {
      const outcome = await Promise.race([placed, sleep(2_000, signal).then(() => 'late' as const)]);
      if (outcome instanceof Error) throw new BodyError(ErrorCodes.INTERNAL, `placement failed: ${outcome.message}`);
    }
    void placed.catch(() => undefined);
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
