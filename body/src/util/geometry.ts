/**
 * Small geometry helpers shared by perception, vision and motor code.
 * Pure functions — no mineflayer dependency — so they are trivially unit-testable.
 */
import type { Vec3Like } from '../protocol.js';

export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Minecraft yaw convention (mineflayer): yaw=0 looks toward +z (south), increases counter-clockwise
 * when viewed from above, i.e. yaw=π/2 looks toward -x (west)... We therefore convert to a
 * conventional compass angle where N = -z, E = +x.
 */
export function bearingTo(from: Vec3Like, to: Vec3Like): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return 'here';
  // angle measured clockwise from north (-z)
  let angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  const idx = Math.round(angle / 45) % 8;
  return COMPASS[idx] ?? 'N';
}

/** Unit forward vector for a mineflayer yaw/pitch (radians). */
export function forwardVector(yaw: number, pitch: number): Vec3Like {
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/**
 * Relative description of a target w.r.t. the viewer's heading: "ahead", "ahead-left", "left",
 * "behind-left", "behind", ... plus "above"/"below" when the vertical offset dominates.
 */
export function relativeDirection(viewer: Vec3Like, yaw: number, target: Vec3Like): string {
  const fwd = forwardVector(yaw, 0);
  const dx = target.x - viewer.x;
  const dy = target.y - viewer.y;
  const dz = target.z - viewer.z;
  const horiz = Math.hypot(dx, dz);
  if (horiz < 0.5 && Math.abs(dy) >= 1.5) return dy > 0 ? 'above' : 'below';
  if (horiz < 1e-6) return 'here';
  // signed angle between forward and target direction (clockwise positive when seen from above)
  const cross = fwd.x * dz - fwd.z * dx; // y component of fwd × dir
  const dot = (fwd.x * dx + fwd.z * dz) / horiz;
  let angle = (Math.atan2(cross / horiz, dot) * 180) / Math.PI; // -180..180
  // With mineflayer's frame (yaw 0 = north/-z, yaw π/2 = west/-x), a positive cross means the
  // target is on the viewer's RIGHT (e.g. facing north, east is +x and gives cross > 0).
  const side = angle > 0 ? 'right' : 'left';
  angle = Math.abs(angle);
  let horizontal: string;
  if (angle <= 22.5) horizontal = 'ahead';
  else if (angle <= 67.5) horizontal = `ahead-${side}`;
  else if (angle <= 112.5) horizontal = side;
  else if (angle <= 157.5) horizontal = `behind-${side}`;
  else horizontal = 'behind';
  if (Math.abs(dy) > horiz && Math.abs(dy) >= 2) horizontal += dy > 0 ? ' (above)' : ' (below)';
  return horizontal;
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function roundVec(v: Vec3Like, digits = 1): Vec3Like {
  return { x: round(v.x, digits), y: round(v.y, digits), z: round(v.z, digits) };
}

export function floorVec(v: Vec3Like): Vec3Like {
  return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) };
}

/**
 * Generate ray directions covering a rectangular field of view, row-major from top-left.
 * Returns unit vectors in world space given the viewer yaw/pitch.
 */
export function fovRays(yaw: number, pitch: number, fovDeg: number, cols: number, rows: number): Vec3Like[] {
  const aspect = cols / rows;
  const hFov = (fovDeg * Math.PI) / 180;
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) / aspect);
  const rays: Vec3Like[] = [];
  for (let r = 0; r < rows; r++) {
    // +pitchOffset looks up for the top rows
    const pitchOffset = (0.5 - (r + 0.5) / rows) * vFov;
    for (let c = 0; c < cols; c++) {
      const yawOffset = (0.5 - (c + 0.5) / cols) * hFov; // left columns look left (positive yaw)
      rays.push(forwardVector(yaw + yawOffset, pitch + pitchOffset));
    }
  }
  return rays;
}

/** Deterministic pastel-ish color for a block name, stable across runs (used by the retina). */
export function colorForName(name: string): [number, number, number] {
  const palette: Record<string, [number, number, number]> = {
    air: [135, 206, 235],
    cave_air: [20, 20, 30],
    water: [40, 90, 200],
    lava: [255, 100, 20],
    grass_block: [92, 160, 60],
    dirt: [120, 80, 50],
    stone: [128, 128, 128],
    deepslate: [70, 70, 75],
    sand: [220, 205, 150],
    gravel: [140, 130, 125],
    snow: [240, 245, 255],
    snow_block: [240, 245, 255],
    oak_log: [110, 80, 45],
    oak_leaves: [50, 120, 40],
    birch_log: [220, 215, 200],
    spruce_log: [60, 40, 25],
    spruce_leaves: [40, 80, 40],
    coal_ore: [50, 50, 50],
    iron_ore: [190, 160, 140],
    copper_ore: [180, 110, 70],
    gold_ore: [230, 200, 60],
    diamond_ore: [100, 230, 230],
    bedrock: [30, 30, 30],
    obsidian: [20, 10, 40],
    netherrack: [110, 40, 40],
    crafting_table: [150, 110, 60],
    furnace: [90, 90, 90],
    chest: [160, 120, 50],
    torch: [255, 220, 100],
  };
  const known = palette[name];
  if (known) return known;
  // FNV-1a hash to RGB
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return [60 + (h & 0x7f), 60 + ((h >>> 8) & 0x7f), 60 + ((h >>> 16) & 0x7f)];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
