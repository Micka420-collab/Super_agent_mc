import { describe, expect, it } from 'vitest';
import { assessSite, cardinalFromYaw, stairStep, stairUpStep, summariseOres, tunnelStep, type BlockLookup } from '../src/motor/digging.js';

/** A solid stone world with a surface at y=64 and a few named cells overridden. */
function world(overrides: Record<string, string | null> = {}, surfaceY = 64): BlockLookup {
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (key in overrides) return overrides[key] as string | null;
    return y >= surfaceY ? 'air' : 'stone';
  };
}

describe('digging survey', () => {
  it('derives a cardinal from the yaw', () => {
    expect(cardinalFromYaw(0)).toBe('north');
    expect(cardinalFromYaw(Math.PI)).toBe('south');
    expect(cardinalFromYaw(Math.PI / 2)).toBe('west');
    expect(cardinalFromYaw(-Math.PI / 2)).toBe('east');
  });

  it('lays out a staircase and a tunnel', () => {
    const s = stairStep({ x: 0.4, y: 64.0, z: 0.6 }, 'east', 2);
    expect(s.feet).toEqual({ x: 2, y: 62, z: 0 });
    expect(s.clear).toEqual([{ x: 2, y: 62, z: 0 }, { x: 2, y: 63, z: 0 }, { x: 2, y: 64, z: 0 }]);
    expect(s.floor).toEqual({ x: 2, y: 61, z: 0 });
    const up = stairUpStep({ x: 0.4, y: 44.0, z: 0.6 }, 'east', 2);
    expect(up.feet).toEqual({ x: 2, y: 46, z: 0 });
    // new feet, new head, and the cell over the previous step's head (room to jump)
    expect(up.clear).toEqual([{ x: 2, y: 46, z: 0 }, { x: 2, y: 47, z: 0 }, { x: 1, y: 47, z: 0 }]);
    expect(up.floor).toEqual({ x: 2, y: 45, z: 0 });
    const t = tunnelStep({ x: 0, y: 10, z: 0 }, 'north', 3);
    expect(t.feet).toEqual({ x: 0, y: 10, z: -3 });
    expect(t.clear).toHaveLength(2);
  });

  it('approves plain stone', () => {
    const r = assessSite(world(), stairStep({ x: 0, y: 64, z: 0 }, 'north', 1));
    expect(r.ok).toBe(true);
    expect(r.floor).toBe('stone');
    expect(r.hazards).toEqual([]);
  });

  it('refuses lava next to the step, water above it and magma under it', () => {
    const step = stairStep({ x: 0, y: 64, z: 0 }, 'north', 1); // feet at (0,63,-1)
    expect(assessSite(world({ '1,63,-1': 'lava' }), step).stop).toMatch(/lava at \(1, 63, -1\)/);
    expect(assessSite(world({ '0,66,-1': 'water' }), step).stop).toMatch(/water/);
    const magma = assessSite(world({ '0,62,-1': 'magma_block' }), step);
    expect(magma.ok).toBe(false);
    expect(magma.stop).toMatch(/magma_block/);
  });

  it('refuses to dig blind or into a hole, and stops at bedrock', () => {
    const step = stairStep({ x: 0, y: 64, z: 0 }, 'south', 1); // feet (0,63,1), floor (0,62,1)
    expect(assessSite(world({ '1,64,2': null }), step).stop).toMatch(/unloaded/);
    expect(assessSite(world({ '0,62,1': 'cave_air' }), step).stop).toMatch(/nothing to stand on/);
    expect(assessSite(world({ '0,62,1': 'water' }), step).stop).toMatch(/water at \(0, 62, 1\)/); // a liquid floor is a hazard first
    expect(assessSite(world({ '0,63,1': 'bedrock' }), step).stop).toBe('bedrock in the way');
    // bedrock outside the cleared cells is fine (it is a wall)
    expect(assessSite(world({ '1,63,1': 'bedrock' }), step).ok).toBe(true);
  });

  it('flags gravel over the column and notices ores on the walls', () => {
    const step = tunnelStep({ x: 0, y: 10, z: 0 }, 'east', 1); // clear (1,10,0),(1,11,0)
    const r = assessSite(world({ '1,12,0': 'gravel', '2,10,0': 'deepslate_diamond_ore', '1,9,0': 'iron_ore', '1,12,1': 'gravel' }, 100), step);
    expect(r.ok).toBe(true);
    expect(r.falling).toEqual([{ x: 1, y: 12, z: 0, name: 'gravel' }]);
    expect(r.ores.map((o) => o.name).sort()).toEqual(['deepslate_diamond_ore', 'iron_ore']);
    expect(summariseOres(r.ores)).toEqual({ deepslate_diamond_ore: 1, iron_ore: 1 });
    // the floor being an ore is still a floor
    expect(r.floor).toBe('iron_ore');
  });
});
