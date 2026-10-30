/**
 * Build feasibility — a dry run of a structure before a single block is placed.
 *
 * Placing a block in Minecraft needs a solid neighbour to click on. A plan is therefore only buildable in an
 * order where every cell gets a solid neighbour by the time its turn comes: the ground, an existing block, or a
 * block of the structure placed earlier. `planBuild` simulates exactly that (a fixpoint over the placements)
 * and returns the order that works, the cells that never get support (floating decorations, roofs without
 * walls), the cells that are enclosed on all six sides when their turn comes (no face to click), the cells
 * already occupied by something else, and the bill of materials. Pure: the world is a callback.
 */
import { distance } from '../util/geometry.js';
import { normalizeName } from './items.js';

export interface Cell {
  x: number;
  y: number;
  z: number;
}

export interface Placement extends Cell {
  name: string;
}

export interface WorldProbe {
  /** Block name at a cell, or null when the chunk is not loaded. */
  blockAt(cell: Cell): string | null;
  /** Can a block be placed into this cell (air, water, grass…)? */
  isReplaceable(name: string | null): boolean;
}

export interface BuildPlan {
  feasible: boolean;
  /** Placements in an order where every block has a solid neighbour when it is placed. */
  order: Placement[];
  alreadyCorrect: Placement[];
  occupied: { placement: Placement; by: string }[];
  unsupported: Placement[];
  enclosed: Placement[];
  unloaded: Placement[];
  materials: Record<string, number>;
  /** Rough duration: ~1.3 s per block plus walking. */
  estimatedSeconds: number;
}

const FACES: Cell[] = [
  { x: 0, y: -1, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
];

const key = (c: Cell): string => `${c.x},${c.y},${c.z}`;

/** Blocks that exist but cannot be clicked on as a reference (no full face). */
const NO_FACE = new Set(['torch', 'wall_torch', 'soul_torch', 'redstone_torch', 'lever', 'tripwire', 'string', 'ladder', 'vine', 'rail', 'powered_rail', 'detector_rail', 'activator_rail', 'redstone_wire', 'snow', 'lily_pad', 'scaffolding']);

export function planBuild(blocks: Placement[], world: WorldProbe, from: Cell): BuildPlan {
  const solid = new Set<string>();
  const unknown = new Set<string>();
  const alreadyCorrect: Placement[] = [];
  const occupied: { placement: Placement; by: string }[] = [];
  const unloaded: Placement[] = [];
  const todo: Placement[] = [];
  const seen = new Set<string>();

  // what is around the structure right now (one block of margin so edges can lean on the ground)
  const probe = (c: Cell): boolean => {
    const k = key(c);
    if (solid.has(k)) return true;
    if (unknown.has(k)) return false;
    const name = world.blockAt(c);
    if (name === null) {
      unknown.add(k);
      return false;
    }
    if (!world.isReplaceable(name) && !NO_FACE.has(name)) {
      solid.add(k);
      return true;
    }
    return false;
  };

  for (const raw of blocks) {
    const p = { ...raw, name: normalizeName(raw.name) };
    const k = key(p);
    if (seen.has(k)) continue; // duplicate cell: first wins
    seen.add(k);
    const here = world.blockAt(p);
    if (here === null) {
      unloaded.push(p);
      continue;
    }
    if (here === p.name) {
      alreadyCorrect.push(p);
      solid.add(k);
      continue;
    }
    if (!world.isReplaceable(here)) {
      occupied.push({ placement: p, by: here });
      solid.add(k); // it is there, whatever it is: later blocks may lean on it
      continue;
    }
    todo.push(p);
  }

  // fixpoint: place everything that has support, repeat until nothing moves
  const order: Placement[] = [];
  const enclosed: Placement[] = [];
  let pending = [...todo].sort((a, b) => a.y - b.y || distance(from, a) - distance(from, b));
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    const next: Placement[] = [];
    for (const p of pending) {
      const neighbours = FACES.map((f) => probe({ x: p.x + f.x, y: p.y + f.y, z: p.z + f.z }));
      const supported = neighbours.some(Boolean);
      const sealed = neighbours.every(Boolean);
      if (!supported) {
        next.push(p);
        continue;
      }
      if (sealed) {
        enclosed.push(p);
        solid.add(key(p)); // treat as filled so neighbours are not mis-judged; it is reported as a problem
        progress = true;
        continue;
      }
      order.push(p);
      solid.add(key(p));
      progress = true;
    }
    pending = next;
  }
  const unsupported = pending;

  const materials: Record<string, number> = {};
  for (const p of order) materials[p.name] = (materials[p.name] ?? 0) + 1;
  // walking: the sum of hops between consecutive placements, at ~3 blocks/s, plus ~1.3 s per placement
  let walk = 0;
  let prev: Cell = from;
  for (const p of order) {
    walk += distance(prev, p);
    prev = p;
  }
  const estimatedSeconds = Math.round(order.length * 1.3 + walk / 3);
  return {
    feasible: unsupported.length === 0 && enclosed.length === 0 && occupied.length === 0 && unloaded.length === 0,
    order,
    alreadyCorrect,
    occupied,
    unsupported,
    enclosed,
    unloaded,
    materials,
    estimatedSeconds,
  };
}

/** One paragraph a planner or a player can act on. */
export function describeBuildPlan(plan: BuildPlan): string {
  const parts = [`${plan.order.length} block${plan.order.length === 1 ? '' : 's'} to place (~${plan.estimatedSeconds}s)`];
  if (plan.alreadyCorrect.length) parts.push(`${plan.alreadyCorrect.length} already in place`);
  if (plan.unsupported.length) parts.push(`${plan.unsupported.length} would float with nothing to place them against (e.g. ${plan.unsupported[0]?.name} at ${key(plan.unsupported[0] as Cell)})`);
  if (plan.enclosed.length) parts.push(`${plan.enclosed.length} enclosed on all sides when their turn comes`);
  if (plan.occupied.length) parts.push(`${plan.occupied.length} occupied by other blocks (e.g. ${plan.occupied[0]?.by} at ${key(plan.occupied[0]?.placement as Cell)})`);
  if (plan.unloaded.length) parts.push(`${plan.unloaded.length} in unloaded chunks`);
  const mats = Object.entries(plan.materials).map(([n, c]) => `${c} ${n}`).join(', ');
  return `${parts.join('; ')}. Materials: ${mats || 'none'}.`;
}
