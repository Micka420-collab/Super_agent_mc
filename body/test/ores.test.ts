import { describe, expect, it } from 'vitest';
import { canonicalOre, describeOre, isOre, miningAdvice, ORE_DEPTHS, oreDepth } from '../src/motor/ores.js';

describe('ore knowledge', () => {
  it('normalises deepslate variants and ignores non-ores', () => {
    expect(canonicalOre('deepslate_diamond_ore')).toBe('diamond_ore');
    expect(canonicalOre('minecraft:iron_ore')).toBe('iron_ore');
    expect(canonicalOre('stone')).toBeNull();
    expect(isOre('deepslate_gold_ore')).toBe(true);
    expect(isOre('gold_block')).toBe(false);
    expect(oreDepth('deepslate_redstone_ore')?.best).toBe(-58);
  });

  it('keeps every span sane', () => {
    for (const [name, d] of Object.entries(ORE_DEPTHS)) {
      expect(d.min, name).toBeLessThan(d.max);
      expect(d.best, name).toBeGreaterThanOrEqual(d.min);
      expect(d.best, name).toBeLessThanOrEqual(d.max);
    }
  });

  it('sends a surface dweller down for diamonds and iron, but not for coal', () => {
    const diamond = miningAdvice(['diamond_ore', 'deepslate_diamond_ore'], 64);
    expect(diamond.move).toBe('descend');
    expect(diamond.targetY).toBe(-58);
    expect(diamond.ore).toBe('diamond_ore');

    const iron = miningAdvice(['iron_ore', 'deepslate_iron_ore'], 70);
    expect(iron.move).toBe('descend');
    expect(iron.targetY).toBe(16);

    expect(miningAdvice(['coal_ore'], 64).move).toBe('here');
  });

  it('stays put when already at a good level, climbs when too deep', () => {
    expect(miningAdvice(['diamond_ore'], -55).move).toBe('here');
    expect(miningAdvice(['iron_ore'], 20).move).toBe('here');
    const up = miningAdvice(['iron_ore', 'deepslate_iron_ore'], -60);
    // iron still exists at -60 but is sparse: the best level is far above
    expect(up.move).toBe('ascend');
    expect(up.targetY).toBe(16);
    expect(miningAdvice(['lapis_ore'], -63).move).toBe('ascend');
  });

  it('knows when depth is not the answer', () => {
    expect(miningAdvice(['emerald_ore'], 64).move).toBe('elsewhere');
    expect(miningAdvice(['ancient_debris'], 64, 'overworld').move).toBe('elsewhere');
    expect(miningAdvice(['ancient_debris'], 64, 'the_nether').move).toBe('descend');
    expect(miningAdvice(['ancient_debris'], 14, 'nether').move).toBe('here');
    expect(miningAdvice(['oak_log'], 64).move).toBe('here');
    expect(miningAdvice(['oak_log'], 64).ore).toBeNull();
  });

  it('describes an ore for a prompt', () => {
    expect(describeOre('deepslate_diamond_ore')).toMatch(/^diamond_ore: Y -64\.\.16, best -58/);
    expect(describeOre('dirt')).toBeNull();
  });
});
