/**
 * Vision providers.
 *
 *  - retina: dependency-free raycast renderer (always available) — see retina.ts
 *  - viewer: prismarine-viewer headless (real textured frames). Needs native deps (gl, canvas);
 *            when they are missing we fall back to the retina and say so in the hello capabilities.
 */
import type { Bot } from 'mineflayer';
import type { Observer } from '../perception/observer.js';
import type { RenderRequest, RenderResult } from '../protocol.js';
import { getLogger } from '../util/logger.js';
import { renderRetina, type RetinaEntityMarker } from './retina.js';
import { classifyEntity } from '../perception/entities.js';
import { distance } from '../util/geometry.js';

export type VisionMode = 'retina' | 'viewer' | 'none';

export interface VisionProvider {
  readonly mode: VisionMode;
  render(req: RenderRequest): Promise<RenderResult>;
}

export class NullVision implements VisionProvider {
  readonly mode = 'none' as const;
  async render(): Promise<RenderResult> {
    throw new Error('vision is disabled (VISION_MODE=none)');
  }
}

export class RetinaVision implements VisionProvider {
  readonly mode = 'retina' as const;
  constructor(
    private readonly bot: Bot,
    private readonly observer: Observer,
  ) {}

  async render(req: RenderRequest): Promise<RenderResult> {
    const bot = this.bot;
    const eye = this.observer.eyePosition();
    const markers: RetinaEntityMarker[] = [];
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position) continue;
      if (distance(e.position, eye) > req.maxDistance) continue;
      const name = e.name ?? e.type ?? 'unknown';
      const kind = classifyEntity({ type: e.type, name, category: bot.registry.entitiesByName?.[name]?.category });
      const mapped: RetinaEntityMarker['kind'] =
        kind === 'player' || kind === 'hostile' || kind === 'passive' || kind === 'neutral' || kind === 'item' ? kind : 'other';
      markers.push({ position: { x: e.position.x, y: e.position.y, z: e.position.z }, kind: mapped, height: (e as unknown as { height?: number }).height ?? 1 });
    }
    return renderRetina(eye, bot.entity.yaw, bot.entity.pitch, this.observer.raycast, req, markers);
  }
}

export async function createVision(bot: Bot, observer: Observer, mode: VisionMode): Promise<VisionProvider> {
  const log = getLogger('vision');
  if (mode === 'none') return new NullVision();
  if (mode === 'viewer') {
    try {
      // Optional dependency — only present when the operator installed it (needs gl + canvas).
      const modName = 'prismarine-viewer';
      await import(/* @vite-ignore */ modName);
      log.warn('prismarine-viewer found but the textured provider is not wired yet; using retina');
    } catch {
      log.warn('VISION_MODE=viewer requested but prismarine-viewer is not installed; using retina');
    }
  }
  return new RetinaVision(bot, observer);
}
