/**
 * Entity classification helpers. Pure functions over plain data so they can be unit-tested
 * without a live bot; the observer feeds them real mineflayer entities.
 */
import type { EntityKind } from '../protocol.js';

/** Mobs that are only dangerous when provoked (minecraft-data lumps them with hostiles or passives). */
export const NEUTRAL_MOBS = new Set([
  'enderman',
  'zombified_piglin',
  'piglin',
  'wolf',
  'bee',
  'iron_golem',
  'llama',
  'trader_llama',
  'dolphin',
  'panda',
  'polar_bear',
  'goat',
  'spider',
  'cave_spider',
  'drowned',
]);

/** Mobs that are always dangerous regardless of what minecraft-data says. */
export const ALWAYS_HOSTILE = new Set([
  'zombie',
  'husk',
  'skeleton',
  'stray',
  'bogged',
  'creeper',
  'witch',
  'slime',
  'magma_cube',
  'phantom',
  'blaze',
  'ghast',
  'wither_skeleton',
  'wither',
  'ender_dragon',
  'guardian',
  'elder_guardian',
  'shulker',
  'vex',
  'vindicator',
  'evoker',
  'pillager',
  'ravager',
  'warden',
  'hoglin',
  'zoglin',
  'piglin_brute',
  'silverfish',
  'endermite',
  'breeze',
  'creaking',
]);

/** Ranged / explosive threats the reflex layer treats specially. */
export const EXPLOSIVE_MOBS = new Set(['creeper']);
export const RANGED_MOBS = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch', 'drowned', 'breeze']);

export interface EntityDescriptor {
  /** mineflayer `entity.type`: 'player' | 'mob' | 'object' | 'orb' | 'projectile' | 'hostile' | ... */
  type: string;
  /** minecraft-data entity name, e.g. 'zombie', 'item', 'arrow' */
  name?: string;
  /** minecraft-data category, e.g. 'Hostile mobs', 'Passive mobs', 'Vehicles', 'Drops', 'Projectiles' */
  category?: string;
}

export function classifyEntity(e: EntityDescriptor): EntityKind {
  const name = e.name ?? '';
  if (e.type === 'player') return 'player';
  if (name === 'item' || e.category === 'Drops') return 'item';
  if (e.type === 'projectile' || e.category === 'Projectiles' || name.includes('arrow') || name === 'fireball') return 'projectile';
  if (e.category === 'Vehicles' || name.includes('boat') || name.includes('minecart')) return 'vehicle';
  if (ALWAYS_HOSTILE.has(name)) return 'hostile';
  if (NEUTRAL_MOBS.has(name)) return 'neutral';
  if (e.type === 'hostile' || e.category === 'Hostile mobs') return 'hostile';
  if (e.type === 'mob' || e.category === 'Passive mobs' || e.category === 'Water creatures' || e.category === 'Ambient mobs') return 'passive';
  return 'other';
}

export function isThreat(kind: EntityKind, name: string, angry = false): boolean {
  if (kind === 'hostile') return true;
  if (kind === 'neutral') return angry || name === 'spider' || name === 'cave_spider' || name === 'drowned';
  return false;
}
