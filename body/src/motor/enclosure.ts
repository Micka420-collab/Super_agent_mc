/**
 * Enclosure — is the agent actually shut in, or can something walk up to it?
 *
 * A bounded flood fill over the open (non-colliding) cells connected to the agent's feet. If the fill runs out of
 * cells before `limit`, the pocket is sealed: nothing can walk or fall in. If it reaches the limit, or touches an
 * unloaded chunk, the agent is exposed. Seen live: a shelter skill reported success while the agent stood in the
 * open, and the mind believed it was safe while its reflexes fled zombies all night.
 *
 * Pure: the caller supplies `solid(x, y, z)` (true = blocks movement, null = unknown/unloaded).
 */

import { Vec3 } from 'vec3';

export type SolidLookup = (x: number, y: number, z: number) => boolean | null;

/** The live lookup: a block blocks movement when its collision box is a full block; unloaded = unknown. */
export function solidLookup(bot: { blockAt: (p: Vec3) => { boundingBox: string } | null }): SolidLookup {
  return (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z));
    return b ? b.boundingBox === 'block' : null;
  };
}

export interface Enclosure {
  /** true when the open space around the agent is closed on every side */
  enclosed: boolean;
  /** open cells reachable from the feet (capped at `limit`) */
  cells: number;
  /** true when the column above the head is covered by a solid block within the pocket */
  roofed: boolean;
  /** one short sentence for the mind */
  summary: string;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
];

export function assessEnclosure(solid: SolidLookup, feet: { x: number; y: number; z: number }, limit = 160): Enclosure {
  const start = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const seen = new Set<string>([key(start.x, start.y, start.z)]);
  const queue: Array<[number, number, number]> = [[start.x, start.y, start.z]];
  let unknown = false;
  while (queue.length && seen.size <= limit) {
    const [x, y, z] = queue.shift() as [number, number, number];
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const k = key(nx, ny, nz);
      if (seen.has(k)) continue;
      const s = solid(nx, ny, nz);
      if (s === true) continue;
      if (s === null) {
        unknown = true;
        continue;
      }
      seen.add(k);
      queue.push([nx, ny, nz]);
    }
  }
  const roofed = solid(start.x, start.y + 2, start.z) === true || solid(start.x, start.y + 1, start.z) === true;
  if (unknown || seen.size > limit) {
    return { enclosed: false, cells: Math.min(seen.size, limit), roofed, summary: 'exposed: open to the outside, monsters can walk or fall to you' };
  }
  return { enclosed: true, cells: seen.size, roofed, summary: `sealed in: ${seen.size} open cells, closed on every side` };
}
