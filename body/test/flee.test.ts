import { describe, expect, it } from 'vitest';
import { fleeDistanceFrom, RANGED_FLEE_DISTANCE } from '../src/motor/reflexes.js';

describe('fleeDistanceFrom', () => {
  it('runs out of an archer\'s range, not just 16 blocks', () => {
    // seen live: fleeing a skeleton to 16 blocks left the bot in range for five flee cycles, until it died
    expect(fleeDistanceFrom('skeleton', 16)).toBe(RANGED_FLEE_DISTANCE);
    expect(RANGED_FLEE_DISTANCE).toBeGreaterThan(16);
  });
  it('keeps the configured distance for melee mobs and a larger configured one', () => {
    expect(fleeDistanceFrom('zombie', 16)).toBe(16);
    expect(fleeDistanceFrom(undefined, 16)).toBe(16);
    expect(fleeDistanceFrom('skeleton', 40)).toBe(40);
  });
});
