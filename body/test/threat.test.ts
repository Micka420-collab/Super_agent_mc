import { describe, expect, it } from 'vitest';
import { armorPoints, assessThreat, weaponDamage, type ThreatInput } from '../src/motor/threat.js';

const base = (over: Partial<ThreatInput> = {}): ThreatInput => ({
  hostiles: [],
  health: 20,
  armor: { head: null, torso: null, legs: null, feet: null },
  heldItem: null,
  offhandItem: null,
  phase: 'day',
  skyLight: 15,
  ...over,
});

describe('threat assessment', () => {
  it('counts armor and weapons like the game does', () => {
    expect(armorPoints({ head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' })).toBe(15);
    expect(armorPoints({ head: null, torso: 'diamond_chestplate', legs: null, feet: 'leather_boots' })).toBe(9);
    expect(armorPoints({ head: 'turtle_helmet' })).toBe(2);
    expect(weaponDamage('diamond_sword')).toBe(7);
    expect(weaponDamage('oak_log')).toBe(1);
    expect(weaponDamage(null)).toBe(1);
  });

  it('is calm with nobody around', () => {
    const a = assessThreat(base());
    expect(a.danger).toBe(0);
    expect(a.recommendation).toBe('calm');
    expect(a.count).toBe(0);
  });

  it('tells a newborn with bare hands to back off from one zombie, and a swordsman to fight it', () => {
    const naked = assessThreat(base({ hostiles: [{ name: 'zombie', distance: 3 }] }));
    expect(naked.recommendation).toBe('retreat');
    expect(naked.reasons).toContain('no armor');
    expect(naked.reasons).toContain('bare hands');
    const armed = assessThreat(base({ hostiles: [{ name: 'zombie', distance: 3 }], heldItem: 'stone_sword' }));
    expect(armed.recommendation).toBe('fight');
    expect(armed.danger).toBeLessThan(naked.danger);
    const knight = assessThreat(base({ hostiles: [{ name: 'zombie', distance: 3 }], heldItem: 'iron_sword', armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } }));
    expect(knight.danger).toBeLessThan(0.25);
    expect(knight.recommendation).toBe('fight');
  });

  it('runs from a crowd at night, even in iron', () => {
    const iron = { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' };
    const crowd = [{ name: 'zombie', distance: 3 }, { name: 'zombie', distance: 4 }, { name: 'spider', distance: 5 }];
    const day = assessThreat(base({ hostiles: crowd, heldItem: 'iron_sword', armor: iron }));
    expect(day.recommendation).toBe('retreat');
    const withArcher = assessThreat(base({ hostiles: [...crowd, { name: 'skeleton', distance: 7 }], heldItem: 'iron_sword', armor: iron }));
    expect(withArcher.recommendation).toBe('flee');
    const night = assessThreat(base({ hostiles: crowd, heldItem: 'iron_sword', armor: iron, phase: 'night', skyLight: 15 }));
    expect(night.danger).toBeGreaterThan(day.danger);
    expect(night.reasons).toContain('night outside: more will come');
    const naked = assessThreat(base({ hostiles: crowd, phase: 'night' }));
    expect(naked.recommendation).toBe('flee');
    expect(naked.danger).toBe(1);
  });

  it('always steps back from a creeper and fears ranged mobs from further away', () => {
    const creeper = assessThreat(base({ hostiles: [{ name: 'creeper', distance: 5 }], heldItem: 'diamond_sword', armor: { torso: 'diamond_chestplate' } }));
    expect(creeper.recommendation).toBe('retreat');
    expect(creeper.reasons[0]).toBe('creeper 5m (explosive)');
    const farZombie = assessThreat(base({ hostiles: [{ name: 'zombie', distance: 14 }] }));
    const farSkeleton = assessThreat(base({ hostiles: [{ name: 'skeleton', distance: 14 }] }));
    expect(farSkeleton.danger).toBeGreaterThan(farZombie.danger);
    expect(farSkeleton.reasons[0]).toBe('skeleton 14m (ranged)');
    const distant = assessThreat(base({ hostiles: [{ name: 'zombie', distance: 30 }], heldItem: 'iron_sword' }));
    expect(distant.recommendation).toBe('watch');
  });

  it('refuses to fight when health is low whatever the gear, and caps at 1', () => {
    const hurt = assessThreat(base({ hostiles: [{ name: 'zombie', distance: 6 }], health: 5, heldItem: 'netherite_sword', offhandItem: 'shield', armor: { head: 'netherite_helmet', torso: 'netherite_chestplate', legs: 'netherite_leggings', feet: 'netherite_boots' } }));
    expect(hurt.recommendation).toBe('flee');
    expect(hurt.reasons).toContain('health 5/20');
    const doom = assessThreat(base({ hostiles: [{ name: 'warden', distance: 3 }] }));
    expect(doom.danger).toBe(1);
    expect(doom.nearest).toEqual({ name: 'warden', distance: 3 });
  });
});
