import { describe, expect, it } from 'vitest';
import { fleeDistanceFrom, RANGED_FLEE_DISTANCE, shouldBreakOff } from '../src/motor/reflexes.js';

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

describe('shouldBreakOff', () => {
  const odds = (danger: number, recommendation: 'fight' | 'flee') => ({ danger, recommendation, reasons: [], count: 1, strength: 0.5 }) as never;
  it('leaves a fight the odds say to run from', () => {
    // seen live: a bare-handed fight against a drowned went on from 20 to 1.7 health
    expect(shouldBreakOff(odds(1, 'flee'), 0.8)).toBe(true);
  });
  it('keeps fighting a fight it can win, or below the threshold', () => {
    expect(shouldBreakOff(odds(0.5, 'fight'), 0.8)).toBe(false);
    expect(shouldBreakOff(odds(0.7, 'flee'), 0.8)).toBe(false);
    expect(shouldBreakOff(null, 0.8)).toBe(false);
  });
});
