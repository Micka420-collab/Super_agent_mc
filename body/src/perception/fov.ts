/**
 * Field-of-view scanner — "honest perception".
 *
 * Instead of letting the mind read every block in a radius (what most Minecraft agents do), this
 * module casts a grid of rays from the eyes through the field of view and reports only what the
 * agent could actually see. The same ray grid feeds the retina renderer (vision/retina.ts), so the
 * symbolic "I can see X" and the pixel image are guaranteed to be consistent.
 *
 * The raycast primitive is injected so the scanner can be unit-tested against a synthetic world.
 */
import type { BlockView, Vec3Like } from '../protocol.js';
import { COMPASS, distance, fovRays, round } from '../util/geometry.js';

export interface RayHit {
  name: string;
  position: Vec3Like;
  /** Exact intersection point, if the raycaster provides it. */
  intersect?: Vec3Like;
  light?: number;
}

export type Raycaster = (from: Vec3Like, direction: Vec3Like, maxDistance: number) => RayHit | null;

export interface FovScanOptions {
  fovDeg: number;
  cols: number;
  rows: number;
  maxDistance: number;
}

export interface FovScanResult {
  /** Per-ray hit (row-major), null when the ray escaped into the sky. */
  hits: (RayHit | null)[];
  /** Unique visible blocks sorted by distance. */
  visible: BlockView[];
  /** Dominant visible block per compass sector, e.g. { N: 'oak_log (12)', E: 'water (30)' }. */
  horizon: Record<string, string>;
}

export const DEFAULT_SCAN: FovScanOptions = { fovDeg: 110, cols: 32, rows: 18, maxDistance: 48 };

export function scanFov(
  eye: Vec3Like,
  yaw: number,
  pitch: number,
  raycast: Raycaster,
  opts: FovScanOptions = DEFAULT_SCAN,
): FovScanResult {
  const rays = fovRays(yaw, pitch, opts.fovDeg, opts.cols, opts.rows);
  const hits: (RayHit | null)[] = new Array(rays.length).fill(null);
  const unique = new Map<string, BlockView>();
  const sectorCounts = new Map<string, Map<string, number>>();

  for (let i = 0; i < rays.length; i++) {
    const dir = rays[i] as Vec3Like;
    const hit = raycast(eye, dir, opts.maxDistance);
    hits[i] = hit;
    if (!hit) continue;
    const key = `${hit.position.x},${hit.position.y},${hit.position.z}`;
    const d = distance(eye, hit.intersect ?? { x: hit.position.x + 0.5, y: hit.position.y + 0.5, z: hit.position.z + 0.5 });
    if (!unique.has(key)) {
      unique.set(key, { name: hit.name, position: hit.position, distance: round(d), ...(hit.light !== undefined ? { light: hit.light } : {}) });
    }
    // compass sector from the ray direction
    let angle = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    const sector = COMPASS[Math.round(angle / 45) % 8] as string;
    if (!sectorCounts.has(sector)) sectorCounts.set(sector, new Map());
    const m = sectorCounts.get(sector) as Map<string, number>;
    m.set(hit.name, (m.get(hit.name) ?? 0) + 1);
  }

  const visible = [...unique.values()].sort((a, b) => a.distance - b.distance);
  const horizon: Record<string, string> = {};
  for (const [sector, counts] of sectorCounts) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    horizon[sector] = top.map(([n, c]) => `${n} (${c})`).join(', ');
  }
  return { hits, visible, horizon };
}

/**
 * Summarise a scan in one or two sentences for the LLM / VLM prompt.
 */
export function describeScan(scan: FovScanResult, maxItems = 12): string {
  if (scan.visible.length === 0) return 'I see only open sky in front of me.';
  const counts = new Map<string, { n: number; nearest: number }>();
  for (const v of scan.visible) {
    const c = counts.get(v.name) ?? { n: 0, nearest: Infinity };
    c.n += 1;
    c.nearest = Math.min(c.nearest, v.distance);
    counts.set(v.name, c);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, maxItems)
    .map(([name, c]) => `${name} ×${c.n} (nearest ${c.nearest}m)`);
  const skyRays = scan.hits.filter((h) => h === null).length;
  const skyPct = Math.round((100 * skyRays) / Math.max(1, scan.hits.length));
  return `In view: ${parts.join('; ')}. Sky covers ~${skyPct}% of the view.`;
}
