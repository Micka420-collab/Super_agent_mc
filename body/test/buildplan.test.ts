import { describe, expect, it } from 'vitest';
import { describeBuildPlan, planBuild, type Placement, type WorldProbe } from '../src/motor/buildplan.js';

/** A flat world: grass at y=63, air above, with optional extra blocks. */
function world(extra: Record<string, string> = {}, unloadedBelowX = -Infinity): WorldProbe {
  return {
    blockAt: (c) => {
      if (c.x < unloadedBelowX) return null;
      const k = `${c.x},${c.y},${c.z}`;
      if (k in extra) return extra[k] as string;
      if (c.y === 63) return 'grass_block';
      if (c.y < 63) return 'stone';
      return 'air';
    },
    isReplaceable: (name) => name === 'air' || name === 'short_grass' || name === 'water',
  };
}

const from = { x: 0, y: 64, z: 0 };
const wall = (x0: number, x1: number, y0: number, y1: number, z: number, name = 'cobblestone'): Placement[] => {
  const out: Placement[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ name, x, y, z });
  return out;
};

describe('planBuild', () => {
  it('orders a wall bottom-up so every block has support, and prices it', () => {
    const plan = planBuild(wall(0, 2, 64, 66, 5), world(), from);
    expect(plan.feasible).toBe(true);
    expect(plan.order).toHaveLength(9);
    for (let i = 1; i < plan.order.length; i++) expect(plan.order[i]!.y).toBeGreaterThanOrEqual(plan.order[i - 1]!.y);
    expect(plan.materials).toEqual({ cobblestone: 9 });
    expect(plan.estimatedSeconds).toBeGreaterThan(9);
    expect(describeBuildPlan(plan)).toContain('9 blocks to place');
  });

  it('places a roof overhang after the wall that will carry it, in one pass order', () => {
    // a 1-wide pillar at x=0 and a roof block hanging next to its top at x=1,y=66: no support until the pillar exists
    const blocks: Placement[] = [{ name: 'oak_planks', x: 1, y: 66, z: 0 }, ...wall(0, 0, 64, 66, 0, 'oak_planks')];
    const plan = planBuild(blocks, world(), from);
    expect(plan.feasible).toBe(true);
    const idx = (x: number, y: number) => plan.order.findIndex((p) => p.x === x && p.y === y);
    expect(idx(1, 66)).toBeGreaterThan(idx(0, 66));
  });

  it('reports floating blocks instead of walking to them', () => {
    const plan = planBuild([{ name: 'glowstone', x: 5, y: 70, z: 5 }, { name: 'cobblestone', x: 0, y: 64, z: 0 }], world(), from);
    expect(plan.feasible).toBe(false);
    expect(plan.unsupported).toEqual([{ name: 'glowstone', x: 5, y: 70, z: 5 }]);
    expect(plan.order).toHaveLength(1);
    expect(describeBuildPlan(plan)).toMatch(/1 would float/);
  });

  it('fills a solid cube from the inside out rather than sealing itself out', () => {
    const cube: Placement[] = [];
    for (let x = 0; x < 3; x++) for (let y = 64; y < 67; y++) for (let z = 0; z < 3; z++) cube.push({ name: 'stone', x, y, z });
    const plan = planBuild(cube, world({ '0,64,0': 'stone', '1,64,0': 'chest' }), from);
    expect(plan.alreadyCorrect).toEqual([{ name: 'stone', x: 0, y: 64, z: 0 }]);
    expect(plan.occupied).toEqual([{ placement: { name: 'stone', x: 1, y: 64, z: 0 }, by: 'chest' }]);
    expect(plan.enclosed).toEqual([]); // the centre is placed before the shell closes around it
    expect(plan.feasible).toBe(false); // because of the chest
    expect(plan.order).toHaveLength(27 - 1 - 1);
  });

  it('detects cells already sealed in by existing blocks, and unloaded chunks', () => {
    // an existing closed shell around (1,65,1): the centre has six solid neighbours and no face to click
    const shell: Record<string, string> = {};
    for (let x = 0; x < 3; x++) for (let y = 64; y < 67; y++) for (let z = 0; z < 3; z++) if (!(x === 1 && y === 65 && z === 1)) shell[`${x},${y},${z}`] = 'stone';
    const plan = planBuild([{ name: 'stone', x: 1, y: 65, z: 1 }], world(shell), from);
    expect(plan.enclosed).toEqual([{ name: 'stone', x: 1, y: 65, z: 1 }]);
    expect(plan.feasible).toBe(false);
    expect(describeBuildPlan(plan)).toMatch(/1 enclosed/);
    const far = planBuild([{ name: 'stone', x: -100, y: 64, z: 0 }], world({}, -50), from);
    expect(far.unloaded).toHaveLength(1);
  });

  it('normalises names and ignores duplicate cells', () => {
    const plan = planBuild([{ name: 'Oak Planks', x: 0, y: 64, z: 0 }, { name: 'oak_planks', x: 0, y: 64, z: 0 }], world(), from);
    expect(plan.order).toEqual([{ name: 'oak_planks', x: 0, y: 64, z: 0 }]);
  });

  it('does not lean on blocks without a clickable face', () => {
    const plan = planBuild([{ name: 'stone', x: 0, y: 70, z: 0 }], world({ '0,69,0': 'torch' }), from);
    expect(plan.unsupported).toHaveLength(1);
  });
});
