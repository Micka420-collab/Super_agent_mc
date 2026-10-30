import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { describeScan, scanFov, type Raycaster } from '../src/perception/fov.js';
import { project, renderRetina } from '../src/vision/retina.js';
import { encodePng } from '../src/util/png.js';
import { fovRays } from '../src/util/geometry.js';

/**
 * Synthetic world: a flat stone floor at y=63 (eye at y=65.6) and an oak_log wall at z=-10.
 */
const syntheticRaycast: Raycaster = (from, dir, maxDistance) => {
  let best: { t: number; hit: ReturnType<Raycaster> } | null = null;
  // floor
  if (dir.y < 0) {
    const t = (64 - from.y) / dir.y; // top surface of the floor block is y=64
    if (t > 0 && t <= maxDistance) best = { t, hit: { name: 'stone', position: { x: Math.floor(from.x + dir.x * t), y: 63, z: Math.floor(from.z + dir.z * t) }, intersect: { x: from.x + dir.x * t, y: 64, z: from.z + dir.z * t } } };
  }
  // wall (plane z = -9 is the near face of blocks at z=-10)
  if (dir.z < 0) {
    const t = (-9 - from.z) / dir.z;
    if (t > 0 && t <= maxDistance && (!best || t < best.t)) {
      const y = from.y + dir.y * t;
      if (y >= 64 && y <= 70) best = { t, hit: { name: 'oak_log', position: { x: Math.floor(from.x + dir.x * t), y: Math.floor(y), z: -10 }, intersect: { x: from.x + dir.x * t, y, z: -9 } } };
    }
  }
  return best ? best.hit : null;
};

describe('fov scan', () => {
  it('sees the wall ahead and the floor below, and sky above', () => {
    const scan = scanFov({ x: 0.5, y: 65.6, z: 0.5 }, 0, 0, syntheticRaycast, { fovDeg: 90, cols: 16, rows: 9, maxDistance: 48 });
    const names = new Set(scan.visible.map((v) => v.name));
    expect(names.has('oak_log')).toBe(true);
    expect(names.has('stone')).toBe(true);
    expect(scan.hits.some((h) => h === null)).toBe(true); // sky
    expect(scan.horizon['N']).toContain('oak_log');
    const text = describeScan(scan);
    expect(text).toMatch(/oak_log/);
    expect(text).toMatch(/Sky covers/);
    // nearest wall block is ~9.5 blocks away
    const wall = scan.visible.find((v) => v.name === 'oak_log')!;
    expect(wall.distance).toBeGreaterThan(9);
    expect(wall.distance).toBeLessThan(12);
  });

  it('facing south sees no wall', () => {
    const scan = scanFov({ x: 0.5, y: 65.6, z: 0.5 }, Math.PI, 0, syntheticRaycast, { fovDeg: 90, cols: 16, rows: 9, maxDistance: 48 });
    expect(scan.visible.some((v) => v.name === 'oak_log')).toBe(false);
  });
});

describe('retina', () => {
  it('renders a valid PNG with a legend and a consistent description', () => {
    const out = renderRetina({ x: 0.5, y: 65.6, z: 0.5 }, 0, 0, syntheticRaycast, { width: 32, height: 18, fovDeg: 90, maxDistance: 48 }, [
      { position: { x: 0.5, y: 64, z: -4 }, kind: 'hostile', height: 1.95 },
    ]);
    const png = Buffer.from(out.pngBase64, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(18);
    expect(Object.values(out.legend)).toContain('oak_log');
    expect(Object.values(out.legend)).toContain('entity:hostile');
    expect(out.description).toMatch(/oak_log/);
    expect(out.source).toBe('retina');
    // decode IDAT and check the hostile marker (pure red) is present near the centre
    const idatLen = png.readUInt32BE(33);
    const idat = png.subarray(41, 41 + idatLen);
    const raw = inflateSync(idat);
    let red = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] === 255 && raw[i + 1] === 0 && raw[i + 2] === 0) red++;
    expect(red).toBeGreaterThan(0);
  });

  it('projects points onto the pixel whose ray passes through them', () => {
    const width = 48;
    const height = 27;
    const fov = 100;
    const eye = { x: 0, y: 70, z: 0 };
    const yaw = 0.7;
    const pitch = -0.2;
    const rays = fovRays(yaw, pitch, fov, width, height);
    for (const idx of [0, 100, 500, 1000, 1295]) {
      const r = rays[idx]!;
      const point = { x: eye.x + r.x * 12, y: eye.y + r.y * 12, z: eye.z + r.z * 12 };
      const px = project(eye, yaw, pitch, fov, width, height, point)!;
      expect(px).not.toBeNull();
      expect(px.row * width + px.col).toBe(idx);
    }
    // behind the camera -> null
    expect(project(eye, 0, 0, fov, width, height, { x: 0, y: 70, z: 10 })).toBeNull();
  });

  it('png encoder rejects wrong buffer sizes', () => {
    expect(() => encodePng(2, 2, new Uint8Array(5))).toThrow(/expected 12 bytes/);
  });
});
