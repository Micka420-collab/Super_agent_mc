import { describe, expect, it } from 'vitest';
import { ProgressWatch } from '../src/motor/movement.js';

describe('ProgressWatch', () => {
  it('stalls when the distance stops shrinking for the whole window', () => {
    const w = new ProgressWatch(25_000, 1.5);
    expect(w.sample(0, 64)).toBe(false);
    expect(w.sample(10_000, 64)).toBe(false);
    expect(w.sample(24_000, 63.5)).toBe(false); // jitter is not progress
    expect(w.sample(25_000, 64)).toBe(true);
  });

  it('a slow but steady walk (or a dig) never stalls', () => {
    const w = new ProgressWatch(25_000, 1.5);
    for (let t = 0, d = 64; t <= 200_000; t += 5_000, d -= 1) expect(w.sample(t, d)).toBe(false);
  });

  it('walking away from the goal (a detour) counts as no progress only after the window', () => {
    const w = new ProgressWatch(25_000, 1.5);
    w.sample(0, 20);
    expect(w.sample(20_000, 30)).toBe(false);
    expect(w.sample(26_000, 28)).toBe(true);
  });
});
