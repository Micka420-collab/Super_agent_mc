import { describe, expect, it } from 'vitest';
import { ActivityWatcher, describeEpisode, type ActivityEpisode } from '../src/perception/activity.js';

const steve = { username: 'Steve', position: { x: 10, y: 64, z: 10 } };
const alex = { username: 'Alex', position: { x: 40, y: 64, z: 40 } };
const me = { position: { x: 30, y: 64, z: 30 }, busy: false };

function watcher(opts?: Partial<ConstructorParameters<typeof ActivityWatcher>[1]>) {
  const episodes: ActivityEpisode[] = [];
  const w = new ActivityWatcher((e) => episodes.push(e), { attributionRadius: 6, windowMs: 8_000, maxBlocks: 96, minBlocks: 3, ...opts });
  return { w, episodes };
}

describe('ActivityWatcher', () => {
  it('credits the nearest player and aggregates a build into one episode', () => {
    const { w, episodes } = watcher();
    let t = 1_000;
    for (let i = 0; i < 12; i++) w.onBlockChange({ x: 11 + (i % 4), y: 64 + Math.floor(i / 4), z: 12 }, 'air', i % 3 ? 'oak_planks' : 'glass_pane', [steve, alex], me, (t += 500));
    expect(episodes).toEqual([]); // still open
    w.tick(t + 9_000);
    expect(episodes).toHaveLength(1);
    const ep = episodes[0]!;
    expect(ep.username).toBe('Steve');
    expect(ep.kind).toBe('built');
    expect(ep.count).toBe(12);
    expect(ep.blocks).toEqual({ oak_planks: 8, glass_pane: 4 });
    expect(ep.min).toEqual({ x: 11, y: 64, z: 12 });
    expect(ep.max).toEqual({ x: 14, y: 66, z: 12 });
    const text = describeEpisode(ep);
    expect(text).toMatch(/^Steve placed 8 oak_planks, 4 glass_pane around \(1[23], 65, 12\) — a 4×3×1 area, \d+s$/);
  });

  it('separates building from digging and closes big episodes early', () => {
    const { w, episodes } = watcher({ maxBlocks: 5 });
    for (let i = 0; i < 5; i++) w.onBlockChange({ x: 10 + i, y: 63, z: 10 }, 'stone', 'air', [steve], me, 1_000 + i);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.kind).toBe('dug');
    expect(episodes[0]!.blocks).toEqual({ stone: 5 });
  });

  it('ignores nature, state changes, replacements, far players and its own busy hands', () => {
    const { w, episodes } = watcher();
    w.onBlockChange({ x: 10, y: 64, z: 10 }, 'air', 'oak_leaves', [steve], me, 1); // leaves: natural
    w.onBlockChange({ x: 10, y: 64, z: 10 }, 'wheat', 'wheat', [steve], me, 2); // crop age
    w.onBlockChange({ x: 10, y: 64, z: 10 }, 'grass_block', 'water', [steve], me, 3); // flow
    w.onBlockChange({ x: 100, y: 64, z: 100 }, 'air', 'stone', [steve], me, 4); // nobody near
    w.onBlockChange({ x: 30, y: 64, z: 31 }, 'air', 'stone', [{ username: 'Alex', position: { x: 31, y: 64, z: 31 } }], { ...me, busy: true }, 5); // we are placing
    for (let i = 0; i < 3; i++) w.onBlockChange({ x: 10, y: 64, z: 10 + i }, 'air', 'torch', [steve], me, 10 + i); // torches do count
    w.flush();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.blocks).toEqual({ torch: 3 });
  });

  it('drops tiny episodes (a single accidental block)', () => {
    const { w, episodes } = watcher();
    w.onBlockChange({ x: 10, y: 64, z: 10 }, 'air', 'cobblestone', [steve], me, 1);
    w.flush();
    expect(episodes).toEqual([]);
  });
});
