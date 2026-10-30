import { describe, expect, it } from 'vitest';
import { assessEnclosure, type SolidLookup } from '../src/motor/enclosure.js';

/** A world of stone with the given open cells carved out (everything else solid). */
function carved(open: Array<[number, number, number]>, unloadedAbove?: number): SolidLookup {
  const air = new Set(open.map(([x, y, z]) => `${x},${y},${z}`));
  return (x, y, z) => {
    if (unloadedAbove !== undefined && y > unloadedAbove) return null;
    return !air.has(`${x},${y},${z}`);
  };
}

describe('assessEnclosure', () => {
  it('a 1×2 pocket dug into stone is sealed and roofed', () => {
    const e = assessEnclosure(carved([[0, 64, 0], [0, 65, 0]]), { x: 0.5, y: 64, z: 0.5 });
    expect(e).toMatchObject({ enclosed: true, cells: 2, roofed: true });
  });

  it('one missing block in the wall exposes the agent to the open field behind it', () => {
    const open: Array<[number, number, number]> = [[0, 64, 0], [0, 65, 0], [1, 64, 0]];
    // the opening leads to a 20×20 open field
    for (let x = 2; x < 22; x++) for (let z = -10; z < 10; z++) open.push([x, 64, z], [x, 65, z]);
    open.push([1, 64, 0]);
    const e = assessEnclosure(carved(open), { x: 0, y: 64, z: 0 });
    expect(e.enclosed).toBe(false);
    expect(e.summary).toMatch(/exposed/);
  });

  it('the open sky (unloaded or unknown cells) never counts as a wall', () => {
    const open: Array<[number, number, number]> = [[0, 64, 0], [0, 65, 0], [0, 66, 0]];
    const e = assessEnclosure(carved(open, 65), { x: 0, y: 64, z: 0 });
    expect(e.enclosed).toBe(false);
  });

  it('a closed 5×5×3 hut counts as sealed', () => {
    const open: Array<[number, number, number]> = [];
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) for (let y = 64; y < 67; y++) open.push([x, y, z]);
    const e = assessEnclosure(carved(open), { x: 2, y: 64, z: 2 });
    expect(e).toMatchObject({ enclosed: true, cells: 75 });
  });

  it('a space larger than the limit is treated as open (a cave is not a shelter)', () => {
    const open: Array<[number, number, number]> = [];
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) open.push([x, 64, z], [x, 65, z]);
    expect(assessEnclosure(carved(open), { x: 0, y: 64, z: 0 }).enclosed).toBe(false);
  });
});
