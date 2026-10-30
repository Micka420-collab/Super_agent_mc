/**
 * Ore knowledge — where things are, by depth.
 *
 * A player who wants diamonds does not wander the surface hoping to trip over them: they dig to Y≈-58. This
 * table encodes the 1.18+ overworld/nether ore distribution (world-generation "triangular" and "uniform"
 * batches, collapsed to the useful numbers: the span where an ore exists and the level where it is densest).
 * The procurement executor and the mind's prompt both lean on it, so `get diamond` becomes "descend, then
 * branch-mine" instead of "explore twice and give up".
 *
 * Pure data + pure functions; the numbers come from the Minecraft wiki (Java 1.18–1.21 ore distribution).
 */

export type OreStrategy = 'descend' | 'surface' | 'mountain' | 'nether';

export interface OreDepth {
  /** lowest Y where the ore generates */
  min: number;
  /** highest Y where the ore generates */
  max: number;
  /** the Y where a branch mine pays the most (the standing level) */
  best: number;
  dimension: 'overworld' | 'nether';
  strategy: OreStrategy;
  /** one-line hint for the mind */
  note: string;
}

export const ORE_DEPTHS: Record<string, OreDepth> = {
  coal_ore: { min: 0, max: 256, best: 96, dimension: 'overworld', strategy: 'surface', note: 'common in exposed stone, hillsides and caves; no need to dig deep' },
  copper_ore: { min: -16, max: 112, best: 48, dimension: 'overworld', strategy: 'descend', note: 'densest around Y 48, very common in dripstone caves' },
  iron_ore: { min: -64, max: 384, best: 16, dimension: 'overworld', strategy: 'descend', note: 'densest around Y 16 underground (and high in mountains above Y 128)' },
  lapis_ore: { min: -64, max: 64, best: 0, dimension: 'overworld', strategy: 'descend', note: 'densest around Y 0' },
  gold_ore: { min: -64, max: 32, best: -16, dimension: 'overworld', strategy: 'descend', note: 'densest around Y -16 (and anywhere in badlands)' },
  redstone_ore: { min: -64, max: 15, best: -58, dimension: 'overworld', strategy: 'descend', note: 'more common the deeper you go, densest near Y -58' },
  diamond_ore: { min: -64, max: 16, best: -58, dimension: 'overworld', strategy: 'descend', note: 'more common the deeper you go; mine at Y -58 (lava lakes sit around Y -54, keep a bucket or back off)' },
  emerald_ore: { min: -16, max: 320, best: 232, dimension: 'overworld', strategy: 'mountain', note: 'only in mountain biomes, high up; trading with villagers is usually easier' },
  nether_quartz_ore: { min: 10, max: 117, best: 40, dimension: 'nether', strategy: 'nether', note: 'everywhere in the nether' },
  nether_gold_ore: { min: 10, max: 117, best: 40, dimension: 'nether', strategy: 'nether', note: 'everywhere in the nether' },
  ancient_debris: { min: 8, max: 119, best: 15, dimension: 'nether', strategy: 'nether', note: 'nether only, densest at Y 15; needs a diamond pickaxe' },
};

/** Blocks that hurt or drown a digger, or that flow into a freshly opened cell. */
export const LIQUID_HAZARDS = new Set(['lava', 'flowing_lava', 'water', 'flowing_water', 'bubble_column']);
/** Blocks a digger must not stand next to / under. */
export const BLOCK_HAZARDS = new Set(['magma_block', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'pointed_dripstone', 'powder_snow']);
/** Blocks that fall when the one below them goes. */
export const FALLING_BLOCKS = new Set(['gravel', 'sand', 'red_sand', 'suspicious_sand', 'suspicious_gravel', 'anvil', 'pointed_dripstone', 'scaffolding', 'white_concrete_powder', 'orange_concrete_powder', 'magenta_concrete_powder', 'light_blue_concrete_powder', 'yellow_concrete_powder', 'lime_concrete_powder', 'pink_concrete_powder', 'gray_concrete_powder', 'light_gray_concrete_powder', 'cyan_concrete_powder', 'purple_concrete_powder', 'blue_concrete_powder', 'brown_concrete_powder', 'green_concrete_powder', 'red_concrete_powder', 'black_concrete_powder']);

/** The canonical ore name for a block ("deepslate_iron_ore" → "iron_ore"). Null when the block is not an ore. */
export function canonicalOre(blockName: string): string | null {
  const n = blockName.replace(/^minecraft:/, '');
  if (ORE_DEPTHS[n]) return n;
  if (n.startsWith('deepslate_')) {
    const base = n.slice('deepslate_'.length);
    return ORE_DEPTHS[base] ? base : null;
  }
  return null;
}

export function isOre(blockName: string): boolean {
  return canonicalOre(blockName) !== null;
}

export function oreDepth(blockName: string): OreDepth | null {
  const c = canonicalOre(blockName);
  return c ? (ORE_DEPTHS[c] ?? null) : null;
}

export type MiningMove = 'descend' | 'ascend' | 'here' | 'elsewhere';

export interface MiningAdvice {
  move: MiningMove;
  /** the Y to stand at when `move` is descend/ascend */
  targetY: number | null;
  ore: string | null;
  reason: string;
}

/**
 * Given the blocks a step wants to mine and where the body is, say whether digging to another level is the
 * sensible thing to do. `here` means "look around / branch-mine at this level"; `elsewhere` means the ore is
 * not a matter of depth (wrong dimension or biome).
 */
export function miningAdvice(blockNames: string[], currentY: number, dimension = 'overworld'): MiningAdvice {
  const dim = dimension.replace('minecraft:', '').replace('the_', '');
  const candidates = blockNames.map((n) => [n, oreDepth(n)] as const).filter((p): p is readonly [string, OreDepth] => p[1] !== null);
  if (!candidates.length) return { move: 'here', targetY: null, ore: null, reason: 'not an ore: look around at this level' };
  const [name, depth] = candidates[0] as readonly [string, OreDepth];
  const ore = canonicalOre(name) ?? name;
  if (depth.dimension !== dim) return { move: 'elsewhere', targetY: null, ore, reason: `${ore} only generates in the ${depth.dimension}` };
  if (depth.strategy === 'mountain') return { move: 'elsewhere', targetY: null, ore, reason: depth.note };
  if (depth.strategy === 'surface') return { move: 'here', targetY: null, ore, reason: depth.note };
  const inSpan = currentY >= depth.min && currentY <= depth.max;
  const far = Math.abs(currentY - depth.best) > 12;
  if (inSpan && !far) return { move: 'here', targetY: null, ore, reason: `Y ${Math.round(currentY)} is already a good level for ${ore} (best ${depth.best})` };
  if (currentY > depth.best) return { move: 'descend', targetY: depth.best, ore, reason: `${ore} is densest near Y ${depth.best}; ${depth.note}` };
  return { move: 'ascend', targetY: depth.best, ore, reason: `${ore} does not generate this deep (span ${depth.min}..${depth.max}); go up to Y ${depth.best}` };
}

/** Human/LLM-readable one-liner for a plan step or a prompt: "iron_ore: densest around Y 16 …". */
export function describeOre(blockName: string): string | null {
  const d = oreDepth(blockName);
  if (!d) return null;
  return `${canonicalOre(blockName)}: Y ${d.min}..${d.max}, best ${d.best} — ${d.note}`;
}
