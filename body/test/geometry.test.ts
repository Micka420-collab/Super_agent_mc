import { describe, expect, it } from 'vitest';
import { bearingTo, colorForName, forwardVector, fovRays, relativeDirection, rgbToHex } from '../src/util/geometry.js';

describe('geometry', () => {
  it('computes compass bearings in Minecraft coordinates (north = -z, east = +x)', () => {
    const o = { x: 0, y: 64, z: 0 };
    expect(bearingTo(o, { x: 0, y: 64, z: -10 })).toBe('N');
    expect(bearingTo(o, { x: 10, y: 64, z: 0 })).toBe('E');
    expect(bearingTo(o, { x: 0, y: 64, z: 10 })).toBe('S');
    expect(bearingTo(o, { x: -10, y: 64, z: 0 })).toBe('W');
    expect(bearingTo(o, { x: 10, y: 64, z: -10 })).toBe('NE');
    expect(bearingTo(o, o)).toBe('here');
  });

  it('forward vector follows mineflayer yaw convention (yaw 0 = north, yaw π/2 = west)', () => {
    const north = forwardVector(0, 0);
    expect(north.z).toBeCloseTo(-1);
    expect(north.x).toBeCloseTo(0);
    const west = forwardVector(Math.PI / 2, 0);
    expect(west.x).toBeCloseTo(-1);
    const up = forwardVector(0, Math.PI / 2);
    expect(up.y).toBeCloseTo(1);
  });

  it('describes relative directions from the viewer heading', () => {
    const me = { x: 0, y: 64, z: 0 };
    // facing north (yaw 0)
    expect(relativeDirection(me, 0, { x: 0, y: 64, z: -5 })).toBe('ahead');
    expect(relativeDirection(me, 0, { x: 5, y: 64, z: 0 })).toBe('right');
    expect(relativeDirection(me, 0, { x: -5, y: 64, z: 0 })).toBe('left');
    expect(relativeDirection(me, 0, { x: 0, y: 64, z: 5 })).toBe('behind');
    expect(relativeDirection(me, 0, { x: 5, y: 64, z: -5 })).toBe('ahead-right');
    // facing west (yaw π/2): north is on the right
    expect(relativeDirection(me, Math.PI / 2, { x: 0, y: 64, z: -5 })).toBe('right');
    // vertical dominance
    expect(relativeDirection(me, 0, { x: 0, y: 70, z: 0 })).toBe('above');
    expect(relativeDirection(me, 0, { x: 0, y: 70, z: -2 })).toContain('(above)');
  });

  it('generates a row-major ray grid with left columns looking left', () => {
    const rays = fovRays(0, 0, 90, 4, 2);
    expect(rays).toHaveLength(8);
    const topLeft = rays[0]!;
    const topRight = rays[3]!;
    // facing north, "left" is west (-x)
    expect(topLeft.x).toBeLessThan(0);
    expect(topRight.x).toBeGreaterThan(0);
    // top rows look up
    expect(topLeft.y).toBeGreaterThan(0);
    expect(rays[4]!.y).toBeLessThan(0);
    for (const r of rays) expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(1, 5);
  });

  it('assigns stable colors to block names', () => {
    expect(colorForName('stone')).toEqual([128, 128, 128]);
    expect(colorForName('some_modded_block')).toEqual(colorForName('some_modded_block'));
    expect(rgbToHex([255, 0, 16])).toBe('#ff0010');
  });
});
