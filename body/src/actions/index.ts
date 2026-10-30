/**
 * Importing this module registers every primitive in the action registry.
 */
import './movement.js';
import './mining.js';
import './crafting.js';
import './building.js';
import './combat.js';
import './inventory.js';
import './social.js';
import './survival.js';
import './perception.js';

export { buildManifest, buildSkillApiDoc, getAction, listActions, parseArgs } from './registry.js';
export type { ActionContext, ActionDef } from './registry.js';
