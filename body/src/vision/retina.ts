/**
 * Retina — pixel perception without a GPU.
 *
 * Renders the agent's point of view as a small PNG straight from the world data: one ray per pixel,
 * color = block identity, brightness = depth. No headless-gl, no node-canvas, works everywhere the
 * body runs. A VLM gets the image plus a legend (color -> block) and the text description produced
 * from the very same rays, so what the mind "sees" and what it "reads" never disagree.
 *
 * It is deliberately low-resolution (default 96×54): cheap enough to render every second, yet
 * enough for a vision model to judge the shape of a build, the layout of a cave or an approaching
 * silhouette.
 */
import type { RenderRequest, RenderResult, Vec3Like } from '../protocol.js';
import { colorForName, rgbToHex } from '../util/geometry.js';
import { encodePng } from '../util/png.js';
import { describeScan, scanFov, type Raycaster } from '../perception/fov.js';

export interface RetinaEntityMarker {
  position: Vec3Like;
  kind: 'player' | 'hostile' | 'passive' | 'neutral' | 'item' | 'other';
  height: number;
}

const ENTITY_COLORS: Record<RetinaEntityMarker['kind'], [number, number, number]> = {
  player: [255, 0, 255],
  hostile: [255, 0, 0],
  neutral: [255, 160, 0],
  passive: [255, 255, 255],
  item: [255, 255, 0],
  other: [200, 200, 255],
};

export function renderRetina(
  eye: Vec3Like,
  yaw: number,
  pitch: number,
  raycast: Raycaster,
  req: RenderRequest,
  entities: RetinaEntityMarker[] = [],
): RenderResult {
  const { width, height, fovDeg, maxDistance } = req;
  const scan = scanFov(eye, yaw, pitch, raycast, { fovDeg, cols: width, rows: height, maxDistance });
  const rgb = new Uint8Array(width * height * 3);
  const legend: Record<string, string> = {};

  for (let i = 0; i < scan.hits.length; i++) {
    const hit = scan.hits[i];
    const o = i * 3;
    if (!hit) {
      // sky gradient: brighter near the horizon, darker at the top
      const row = Math.floor(i / width);
      const t = row / Math.max(1, height - 1);
      rgb[o] = Math.round(110 + 60 * t);
      rgb[o + 1] = Math.round(170 + 40 * t);
      rgb[o + 2] = Math.round(235 - 20 * t);
      continue;
    }
    const base = colorForName(hit.name);
    const p = hit.intersect ?? { x: hit.position.x + 0.5, y: hit.position.y + 0.5, z: hit.position.z + 0.5 };
    const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    // depth shading: 1.0 at 0m -> 0.35 at maxDistance
    const shade = 1 - 0.65 * Math.min(1, d / maxDistance);
    rgb[o] = Math.round((base[0] as number) * shade);
    rgb[o + 1] = Math.round((base[1] as number) * shade);
    rgb[o + 2] = Math.round((base[2] as number) * shade);
    legend[rgbToHex(base)] = hit.name;
  }

  // Overlay entities as bright markers (projected through the same camera model).
  for (const ent of entities) {
    const px = project(eye, yaw, pitch, fovDeg, width, height, { x: ent.position.x, y: ent.position.y + ent.height / 2, z: ent.position.z });
    if (!px) continue;
    const d = Math.hypot(ent.position.x - eye.x, ent.position.y - eye.y, ent.position.z - eye.z);
    if (d > maxDistance) continue;
    // occlusion test: is the ray at that pixel hitting something closer than the entity?
    const idx = px.row * width + px.col;
    const hit = scan.hits[idx];
    if (hit) {
      const hp = hit.intersect ?? { x: hit.position.x + 0.5, y: hit.position.y + 0.5, z: hit.position.z + 0.5 };
      const hd = Math.hypot(hp.x - eye.x, hp.y - eye.y, hp.z - eye.z);
      if (hd < d - 0.5) continue;
    }
    const size = Math.max(1, Math.round((ent.height * height) / (2 * d * Math.tan(((fovDeg * Math.PI) / 180) / 2) * (height / width))));
    const color = ENTITY_COLORS[ent.kind];
    const half = Math.max(0, Math.floor(size / 2));
    for (let r = px.row - half; r <= px.row + half; r++) {
      for (let c = px.col - Math.ceil(half / 2); c <= px.col + Math.ceil(half / 2); c++) {
        if (r < 0 || r >= height || c < 0 || c >= width) continue;
        const o = (r * width + c) * 3;
        rgb[o] = color[0];
        rgb[o + 1] = color[1];
        rgb[o + 2] = color[2];
      }
    }
    legend[rgbToHex(color)] = `entity:${ent.kind}`;
  }

  const png = encodePng(width, height, rgb);
  return {
    width,
    height,
    pngBase64: png.toString('base64'),
    legend,
    description: describeScan(scan),
    source: 'retina',
  };
}

/**
 * Project a world point into retina pixel coordinates using the same equiangular camera model as
 * `fovRays` (rays are evenly spaced in yaw/pitch, not on a planar sensor), so entity markers land
 * exactly on the pixels whose rays pass through them.
 * Returns null when the point is outside the field of view or behind the camera.
 */
export function project(
  eye: Vec3Like,
  yaw: number,
  pitch: number,
  fovDeg: number,
  width: number,
  height: number,
  point: Vec3Like,
): { col: number; row: number } | null {
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const horiz = Math.hypot(dx, dz);
  if (horiz < 1e-6 && Math.abs(dy) < 1e-6) return null;
  // world-frame yaw/pitch of the point (mineflayer convention, see bot.lookAt)
  const pointYaw = Math.atan2(-dx, -dz);
  const pointPitch = Math.atan2(dy, horiz);
  let yawOffset = pointYaw - yaw;
  while (yawOffset > Math.PI) yawOffset -= 2 * Math.PI;
  while (yawOffset < -Math.PI) yawOffset += 2 * Math.PI;
  const pitchOffset = pointPitch - pitch;
  const hFov = (fovDeg * Math.PI) / 180;
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) / (width / height));
  if (Math.abs(yawOffset) > hFov / 2 || Math.abs(pitchOffset) > vFov / 2) return null;
  // invert fovRays: yawOffset = (0.5 - (c + 0.5) / cols) * hFov
  const col = Math.min(width - 1, Math.max(0, Math.round((0.5 - yawOffset / hFov) * width - 0.5)));
  const row = Math.min(height - 1, Math.max(0, Math.round((0.5 - pitchOffset / vFov) * height - 0.5)));
  return { col, row };
}
