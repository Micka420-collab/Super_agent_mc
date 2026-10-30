/**
 * Threat assessment — "can I take them?" answered without a language model.
 *
 * A player reads a situation in a glance: three zombies at night with bare hands is a run, a lone zombie with an
 * iron sword is a fight, a creeper is always a step back. This module scores it: the pressure the hostiles exert
 * (what they are, how close, whether they shoot) against what the body can absorb and deal (health, armor,
 * weapon, shield), with the night and the open sky counted in. The score goes into the observation
 * (`entities.threat`) so the mind sees "danger 0.78 — flee: 3 zombies, no armor, night", and into the reflexes,
 * which run from the same numbers.
 *
 * Pure function over plain data; the observer and the reflex system build the input from the live bot.
 */
import { EXPLOSIVE_MOBS, RANGED_MOBS } from '../perception/entities.js';

/** How much trouble one of these is at arm's length, relative to a zombie (1.0). */
export const MOB_WEIGHT: Record<string, number> = {
  zombie: 1.0, husk: 1.0, zombie_villager: 1.0, drowned: 1.2, skeleton: 1.4, stray: 1.5, bogged: 1.5, spider: 0.9, cave_spider: 1.2,
  creeper: 1.8, witch: 1.6, enderman: 2.0, slime: 0.6, magma_cube: 1.2, phantom: 1.0, blaze: 1.8, ghast: 1.5, wither_skeleton: 2.2,
  piglin: 1.2, piglin_brute: 3.0, zombified_piglin: 1.3, hoglin: 2.0, zoglin: 2.2, pillager: 1.5, vindicator: 2.5, evoker: 2.5,
  ravager: 3.5, vex: 1.5, warden: 10, wither: 10, ender_dragon: 10, guardian: 1.8, elder_guardian: 3.0, silverfish: 0.5,
  endermite: 0.4, breeze: 1.5, creaking: 2.0, wolf: 0.8, polar_bear: 1.5, iron_golem: 3.0, bee: 0.3,
};

/** Armor points per piece (Minecraft armor values), by material prefix. */
const ARMOR_POINTS: Record<string, [number, number, number, number]> = {
  leather: [1, 3, 2, 1],
  chainmail: [2, 5, 4, 1],
  golden: [2, 5, 3, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3],
  turtle: [2, 0, 0, 0],
};
const PIECE_INDEX: Record<string, number> = { helmet: 0, chestplate: 1, leggings: 2, boots: 3 };

/** Attack damage of the thing in hand. */
const WEAPON_DAMAGE: Record<string, number> = {
  wooden_sword: 4, stone_sword: 5, golden_sword: 4, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
  wooden_axe: 7, stone_axe: 9, golden_axe: 7, iron_axe: 9, diamond_axe: 9, netherite_axe: 10,
  trident: 9, mace: 6, wooden_pickaxe: 2, stone_pickaxe: 3, iron_pickaxe: 4, diamond_pickaxe: 5, netherite_pickaxe: 6,
};

export interface ThreatInput {
  hostiles: { name: string; distance: number; visible?: boolean }[];
  health: number;
  /** armor slot → item name or null */
  armor: Record<string, string | null | undefined>;
  heldItem: string | null | undefined;
  offhandItem: string | null | undefined;
  phase: 'dawn' | 'day' | 'dusk' | 'night';
  /** sky light at the feet: > 4 means outdoors */
  skyLight: number;
}

export type ThreatRecommendation = 'calm' | 'watch' | 'fight' | 'retreat' | 'flee';

export interface ThreatAssessment {
  /** 0 (nothing) .. 1 (run for your life) */
  danger: number;
  recommendation: ThreatRecommendation;
  /** what pushed the number: "creeper 3m (explosive)", "no armor", "night outside" */
  reasons: string[];
  count: number;
  /** how much the body can take and give, 0.5 (naked, fists) .. ~2.8 (full netherite + shield) */
  strength: number;
  /** the most pressing hostile, if any */
  nearest: { name: string; distance: number } | null;
}

export function armorPoints(armor: Record<string, string | null | undefined>): number {
  let pts = 0;
  for (const name of Object.values(armor)) {
    if (!name) continue;
    const [material, piece] = name.split('_');
    const table = material ? ARMOR_POINTS[material] : undefined;
    const idx = piece ? PIECE_INDEX[piece] : undefined;
    if (table && idx !== undefined) pts += table[idx] ?? 0;
  }
  return pts;
}

export function weaponDamage(item: string | null | undefined): number {
  return item ? (WEAPON_DAMAGE[item] ?? 1) : 1;
}

/** Pressure one hostile exerts from its distance: melee fades fast, ranged mobs reach further. */
function distanceFactor(name: string, distance: number): number {
  const ranged = RANGED_MOBS.has(name);
  if (distance <= 4) return 1.0;
  if (distance <= 8) return ranged ? 0.9 : 0.75;
  if (distance <= 16) return ranged ? 0.7 : 0.45;
  if (distance <= 24) return ranged ? 0.4 : 0.2;
  return 0.1;
}

export function assessThreat(input: ThreatInput): ThreatAssessment {
  const reasons: string[] = [];
  const hostiles = [...input.hostiles].sort((a, b) => a.distance - b.distance);
  const nearest = hostiles[0] ? { name: hostiles[0].name, distance: hostiles[0].distance } : null;
  if (!hostiles.length) return { danger: 0, recommendation: 'calm', reasons: [], count: 0, strength: bodyStrength(input), nearest: null };

  let pressure = 0;
  for (const h of hostiles) {
    const w = MOB_WEIGHT[h.name] ?? 1.0;
    const f = distanceFactor(h.name, h.distance);
    pressure += w * f;
    if (f >= 0.45) {
      const tag = EXPLOSIVE_MOBS.has(h.name) ? ' (explosive)' : RANGED_MOBS.has(h.name) ? ' (ranged)' : '';
      reasons.push(`${h.name} ${Math.round(h.distance)}m${tag}`);
    }
  }
  const strength = bodyStrength(input, reasons);
  const healthFactor = Math.max(0, Math.min(1, input.health / 20));
  const capacity = strength * (0.4 + 0.6 * healthFactor);
  let danger = pressure / (capacity * 3);
  if (input.phase === 'night' && input.skyLight > 4) {
    danger += 0.1;
    reasons.push('night outside: more will come');
  }
  if (input.health <= 6) {
    danger = Math.max(danger, 0.75);
    reasons.push(`health ${Math.round(input.health)}/20`);
  }
  danger = Math.max(0, Math.min(1, danger));

  let recommendation: ThreatRecommendation;
  if (danger < 0.2) recommendation = nearest && nearest.distance > 10 ? 'watch' : 'fight';
  else if (danger < 0.45) recommendation = 'fight';
  else if (danger < 0.7) recommendation = 'retreat';
  else recommendation = 'flee';
  if (nearest && EXPLOSIVE_MOBS.has(nearest.name) && nearest.distance <= 6 && recommendation === 'fight') recommendation = 'retreat';

  return { danger: Math.round(danger * 100) / 100, recommendation, reasons: reasons.slice(0, 6), count: hostiles.length, strength: Math.round(strength * 100) / 100, nearest };
}

function bodyStrength(input: ThreatInput, reasons?: string[]): number {
  const armor = armorPoints(input.armor);
  const dmg = weaponDamage(input.heldItem);
  const shield = input.offhandItem === 'shield';
  if (reasons) {
    if (armor === 0) reasons.push('no armor');
    if (dmg <= 1) reasons.push('bare hands');
  }
  return 0.5 + (armor / 20) * 1.0 + ((dmg - 1) / 7) * 0.8 + (shield ? 0.3 : 0);
}
