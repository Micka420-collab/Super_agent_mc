/**
 * Watching other players work — the perception half of learning by observation.
 *
 * Every block change the client sees is attributed to the nearest player within arm's reach (and never to the
 * agent itself, whose own actions already report `block.broken` / `block.placed`). Changes are aggregated per
 * player into short episodes ("Steve placed 24 oak_planks and 6 glass_pane around (12, 64, -40) over 40 s"),
 * which is what a person would remember after watching a neighbour build — not a stream of single blocks.
 * Pure logic over positions and names: unit-tested without a server.
 */
import type { Vec3Like } from '../protocol.js';

export interface NearbyPlayer {
  username: string;
  position: Vec3Like;
}

export interface ActivityEpisode {
  username: string;
  /** 'built' = blocks appeared, 'dug' = blocks disappeared */
  kind: 'built' | 'dug';
  blocks: Record<string, number>;
  count: number;
  min: Vec3Like;
  max: Vec3Like;
  startedAt: number;
  endedAt: number;
}

export interface ActivityWatcherOptions {
  /** How close a player must be to a changed block to be credited with it. */
  attributionRadius: number;
  /** Silence after which an episode is closed. */
  windowMs: number;
  /** Episodes are also closed when they grow this big. */
  maxBlocks: number;
  /** Episodes smaller than this are dropped (a torch, an accidental dig) unless the player then continues. */
  minBlocks: number;
}

export const DEFAULT_ACTIVITY_OPTIONS: ActivityWatcherOptions = { attributionRadius: 6, windowMs: 8_000, maxBlocks: 96, minBlocks: 3 };

/** Block names whose appearance/disappearance is weather, growth or physics — not a player's hands. */
const NATURAL = new Set([
  'air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire', 'snow', 'snow_block', 'ice', 'frosted_ice',
  'grass_block', 'dirt', 'farmland', 'dirt_path', 'mycelium', 'podzol', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves',
  'sugar_cane', 'bamboo', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'vine', 'cave_vines', 'cave_vines_plant', 'weeping_vines', 'twisting_vines', 'sculk_vein',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem', 'attached_melon_stem', 'attached_pumpkin_stem', 'sweet_berry_bush', 'cocoa', 'nether_wart',
  'gravel', 'sand', 'red_sand', 'dripstone_block', 'pointed_dripstone', 'cobweb', 'moving_piston', 'piston_head',
]);

const isAirLike = (name: string): boolean => name === 'air' || name === 'cave_air' || name === 'void_air';

function dist(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class ActivityWatcher {
  private readonly open = new Map<string, ActivityEpisode>();

  constructor(
    private readonly onEpisode: (episode: ActivityEpisode) => void,
    private readonly opts: ActivityWatcherOptions = DEFAULT_ACTIVITY_OPTIONS,
  ) {}

  /**
   * A block changed. `players` are the other players currently known (not the agent); `self` is the agent's own
   * position and whether its hands are busy with a block action right now (then nearby changes are probably its own).
   */
  onBlockChange(position: Vec3Like, oldName: string, newName: string, players: NearbyPlayer[], self: { position: Vec3Like; busy: boolean }, now = Date.now()): void {
    if (oldName === newName) return; // state-only change (crop age, door swing, redstone)
    const placed = isAirLike(oldName) && !isAirLike(newName);
    const dug = !isAirLike(oldName) && isAirLike(newName);
    if (!placed && !dug) return; // replacement (water flowing over grass, fire spreading): not hands
    const subject = placed ? newName : oldName;
    if (NATURAL.has(subject)) return;
    const centre = { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 };
    const near = players.filter((p) => dist({ x: p.position.x, y: p.position.y + 1, z: p.position.z }, centre) <= this.opts.attributionRadius);
    if (!near.length) return;
    // if we are also within reach and busy with our own block work, the change is probably ours
    if (self.busy && dist({ x: self.position.x, y: self.position.y + 1, z: self.position.z }, centre) <= this.opts.attributionRadius) return;
    near.sort((a, b) => dist(a.position, centre) - dist(b.position, centre));
    const who = (near[0] as NearbyPlayer).username;
    const kind: ActivityEpisode['kind'] = placed ? 'built' : 'dug';
    const key = `${who}:${kind}`;
    let ep = this.open.get(key);
    if (ep && now - ep.endedAt > this.opts.windowMs) {
      this.close(key, ep);
      ep = undefined;
    }
    if (!ep) {
      ep = { username: who, kind, blocks: {}, count: 0, min: { ...position }, max: { ...position }, startedAt: now, endedAt: now };
      this.open.set(key, ep);
    }
    ep.blocks[subject] = (ep.blocks[subject] ?? 0) + 1;
    ep.count += 1;
    ep.endedAt = now;
    ep.min = { x: Math.min(ep.min.x, position.x), y: Math.min(ep.min.y, position.y), z: Math.min(ep.min.z, position.z) };
    ep.max = { x: Math.max(ep.max.x, position.x), y: Math.max(ep.max.y, position.y), z: Math.max(ep.max.z, position.z) };
    if (ep.count >= this.opts.maxBlocks) this.close(key, ep);
  }

  /** Close episodes that have gone quiet. Call every second or so. */
  tick(now = Date.now()): void {
    for (const [key, ep] of [...this.open.entries()]) {
      if (now - ep.endedAt > this.opts.windowMs) this.close(key, ep);
    }
  }

  /** Close everything (e.g. before shutting down). */
  flush(): void {
    for (const [key, ep] of [...this.open.entries()]) this.close(key, ep);
  }

  private close(key: string, ep: ActivityEpisode): void {
    this.open.delete(key);
    if (ep.count >= this.opts.minBlocks) this.onEpisode(ep);
  }
}

/** One line a mind can remember: "Steve placed 24 oak_planks, 6 glass_pane around (12, 64, -40) in 40s". */
export function describeEpisode(ep: ActivityEpisode): string {
  const centre = { x: Math.round((ep.min.x + ep.max.x) / 2), y: Math.round((ep.min.y + ep.max.y) / 2), z: Math.round((ep.min.z + ep.max.z) / 2) };
  const parts = Object.entries(ep.blocks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([n, c]) => `${c} ${n}`)
    .join(', ');
  const secs = Math.max(1, Math.round((ep.endedAt - ep.startedAt) / 1000));
  const size = `${ep.max.x - ep.min.x + 1}×${ep.max.y - ep.min.y + 1}×${ep.max.z - ep.min.z + 1}`;
  return `${ep.username} ${ep.kind === 'built' ? 'placed' : 'dug'} ${parts} around (${centre.x}, ${centre.y}, ${centre.z}) — a ${size} area, ${secs}s`;
}
