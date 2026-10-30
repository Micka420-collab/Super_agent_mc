/**
 * Safe digging — the survey a careful miner does before every swing of the pickaxe.
 *
 * Pure functions over a block lookup so the rules can be unit-tested on a hand-made world: the cells a step will
 * open, their neighbours (liquids flow in, magma burns), the floor under the next footstep (caves are holes),
 * the blocks overhead (gravel falls), chunks that are not loaded (never dig blind), and the ores that a real
 * player would notice on the tunnel walls. `descend` and `tunnel` (actions/mining.ts) run this survey at each
 * step and stop with a precise reason instead of walking into lava.
 */
import type { Vec3Like } from '../protocol.js';
import { BLOCK_HAZARDS, FALLING_BLOCKS, LIQUID_HAZARDS, isOre } from './ores.js';

/** Returns the block name at a position, or null when the chunk is not loaded. */
export type BlockLookup = (x: number, y: number, z: number) => string | null;

export type Cardinal = 'north' | 'south' | 'east' | 'west';
export const CARDINALS: Record<Cardinal, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

const AIR = new Set(['air', 'cave_air', 'void_air']);
/** Blocks that are open space or will not hold a player: not a floor. */
const NOT_A_FLOOR = new Set([...AIR, ...LIQUID_HAZARDS, 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'seagrass', 'kelp', 'vine', 'snow', 'torch', 'wall_torch', 'rail', 'powder_snow']);

export interface NamedCell extends Vec3Like {
  name: string;
}

export interface SiteReport {
  /** safe to open these cells now */
  ok: boolean;
  /** why not, in words the mind understands */
  stop?: string;
  /** hazards seen in the survey box (liquids, magma, fire…) with positions */
  hazards: NamedCell[];
  /** gravity blocks sitting right above the cells to clear (dig them from below, step back, repeat) */
  falling: NamedCell[];
  /** ores exposed in the survey box — a miner notices the walls */
  ores: NamedCell[];
  /** blocks in the box that were not loaded */
  unloaded: number;
  /** the block under the next footstep */
  floor: string | null;
}

/** The dominant horizontal axis of a yaw (mineflayer convention: dx = -sin(yaw), dz = -cos(yaw)). */
export function cardinalFromYaw(yaw: number): Cardinal {
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

export interface Course {
  /** cells to clear for this step, bottom first */
  clear: Vec3Like[];
  /** where the feet go once cleared */
  feet: Vec3Like;
  /** the block that must hold the feet */
  floor: Vec3Like;
}

/** Cells of the i-th step (1-based) of a 1-wide staircase going down (3 cleared per step: feet, head, headroom). */
export function stairStep(origin: Vec3Like, dir: Cardinal, i: number): Course {
  const [dx, dz] = CARDINALS[dir];
  const x = Math.floor(origin.x) + dx * i;
  const y = Math.floor(origin.y) - i;
  const z = Math.floor(origin.z) + dz * i;
  return { clear: [{ x, y, z }, { x, y: y + 1, z }, { x, y: y + 2, z }], feet: { x, y, z }, floor: { x, y: y - 1, z } };
}

/**
 * Cells of the i-th step of a staircase going UP (out of a pit or a sealed shelter): the new feet and head cells,
 * plus the cell above the current head so there is room to jump. The floor is the untouched block under the step.
 */
export function stairUpStep(origin: Vec3Like, dir: Cardinal, i: number): Course {
  const [dx, dz] = CARDINALS[dir];
  const x = Math.floor(origin.x) + dx * i;
  const y = Math.floor(origin.y) + i;
  const z = Math.floor(origin.z) + dz * i;
  const px = x - dx;
  const pz = z - dz;
  return { clear: [{ x, y, z }, { x, y: y + 1, z }, { x: px, y: y + 1, z: pz }], feet: { x, y, z }, floor: { x, y: y - 1, z } };
}

/** Cells of the i-th step of a 1×2 horizontal tunnel. */
export function tunnelStep(origin: Vec3Like, dir: Cardinal, i: number): Course {
  const [dx, dz] = CARDINALS[dir];
  const x = Math.floor(origin.x) + dx * i;
  const y = Math.floor(origin.y);
  const z = Math.floor(origin.z) + dz * i;
  return { clear: [{ x, y, z }, { x, y: y + 1, z }], feet: { x, y, z }, floor: { x, y: y - 1, z } };
}

/**
 * Survey one course before digging it. The box is the cleared cells plus one block on every side (two above,
 * so the block that would fall onto the headroom is seen) and the floor below the feet.
 */
export function assessSite(lookup: BlockLookup, course: Course, margin = 1): SiteReport {
  const report: SiteReport = { ok: true, hazards: [], falling: [], ores: [], unloaded: 0, floor: null };
  const xs = course.clear.map((c) => c.x);
  const ys = course.clear.map((c) => c.y);
  const zs = course.clear.map((c) => c.z);
  const minX = Math.min(...xs) - margin;
  const maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys, course.floor.y);
  const maxY = Math.max(...ys) + margin + 1;
  const minZ = Math.min(...zs) - margin;
  const maxZ = Math.max(...zs) + margin;
  const clearKeys = new Set(course.clear.map((c) => `${c.x},${c.y},${c.z}`));
  const topY = Math.max(...ys);
  let bedrock = false;

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const name = lookup(x, y, z);
        if (name === null) {
          report.unloaded += 1;
          continue;
        }
        const key = `${x},${y},${z}`;
        if (LIQUID_HAZARDS.has(name) || BLOCK_HAZARDS.has(name)) report.hazards.push({ x, y, z, name });
        if (name === 'bedrock' && clearKeys.has(key)) bedrock = true;
        if (isOre(name)) report.ores.push({ x, y, z, name });
        // a gravity block right above the column we open will come down on us
        if (FALLING_BLOCKS.has(name) && y === topY + 1 && course.clear.some((c) => c.x === x && c.z === z)) report.falling.push({ x, y, z, name });
      }
    }
  }
  report.floor = lookup(course.floor.x, course.floor.y, course.floor.z);

  if (report.unloaded > 0) {
    report.ok = false;
    report.stop = `${report.unloaded} unloaded block${report.unloaded > 1 ? 's' : ''} around the next step — not digging blind`;
  } else if (report.hazards.length) {
    const h = report.hazards[0] as NamedCell;
    report.ok = false;
    report.stop = `${h.name} at (${h.x}, ${h.y}, ${h.z}), next to the step`;
  } else if (bedrock) {
    report.ok = false;
    report.stop = 'bedrock in the way';
  } else if (report.floor === null || NOT_A_FLOOR.has(report.floor)) {
    report.ok = false;
    report.stop = `nothing to stand on under the next step (${report.floor ?? 'unloaded'}) — a cave or a drop`;
  }
  return report;
}

/** Words for the report of a dig: the ores seen, grouped. */
export function summariseOres(ores: NamedCell[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of ores) out[o.name] = (out[o.name] ?? 0) + 1;
  return out;
}

/**
 * Natural terrain a player may dig through to reach something: never a block someone placed (planks, bricks,
 * cobblestone walls, glass…). Ores count as terrain.
 */
const TERRAIN = new Set(['stone', 'deepslate', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'gravel', 'sand', 'red_sand', 'clay', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'dripstone_block', 'netherrack', 'blackstone', 'basalt', 'smooth_basalt', 'soul_sand', 'soul_soil', 'end_stone', 'snow_block', 'mud', 'moss_block', 'terracotta', 'sandstone', 'red_sandstone']);

export function isTerrain(name: string): boolean {
  return TERRAIN.has(name) || name.endsWith('_ore') || name.endsWith('_terracotta') || name === 'ancient_debris';
}

export type ApproachStep = { kind: 'tunnel' | 'up' | 'down'; direction: Cardinal };

/**
 * The next 1-block step of a corridor dug from `feet` towards `target`: along the larger horizontal axis, climbing
 * or descending one block per step while the target is more than one block above or below. Null when the target
 * is straight above or below (there is no horizontal way to go).
 */
export function nextApproachStep(feet: Vec3Like, target: Vec3Like): ApproachStep | null {
  const dx = Math.floor(target.x) - Math.floor(feet.x);
  const dz = Math.floor(target.z) - Math.floor(feet.z);
  const dy = Math.floor(target.y) - Math.floor(feet.y);
  if (dx === 0 && dz === 0) return null;
  const direction: Cardinal = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : dz > 0 ? 'south' : 'north';
  const kind = dy > 1 ? 'up' : dy < -1 ? 'down' : 'tunnel';
  return { kind, direction };
}
