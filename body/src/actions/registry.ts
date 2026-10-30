/**
 * Action registry — every motor primitive the mind (or a skill) can invoke is declared here with a
 * zod schema, so the body can validate arguments, auto-generate the tool manifest for the LLM, and
 * document the skill API from a single source of truth.
 */
import type { Bot } from 'mineflayer';
import { z } from 'zod';
import type { ActionManifestEntry } from '../protocol.js';
import { BodyError, ErrorCodes } from '../protocol.js';
import type { Observer } from '../perception/observer.js';
import type { Logger } from '../util/logger.js';

export type ActionCategory = ActionManifestEntry['category'];

export interface ActionContext {
  bot: Bot;
  observer: Observer;
  signal: AbortSignal;
  log: Logger;
  /** Report intermediate progress (forwarded to the mind as an event). */
  progress: (message: string, data?: Record<string, unknown>) => void;
}

export interface ActionDef<S extends z.ZodType = z.ZodType> {
  name: string;
  category: ActionCategory;
  description: string;
  schema: S;
  longRunning: boolean;
  run: (ctx: ActionContext, args: z.infer<S>) => Promise<unknown>;
}

const registry = new Map<string, ActionDef>();

export function defineAction<S extends z.ZodType>(def: ActionDef<S>): ActionDef<S> {
  if (registry.has(def.name)) throw new Error(`action already defined: ${def.name}`);
  registry.set(def.name, def as unknown as ActionDef);
  return def;
}

export function getAction(name: string): ActionDef {
  const def = registry.get(name);
  if (!def) throw new BodyError(ErrorCodes.UNKNOWN_ACTION, `unknown action: ${name}`, { known: [...registry.keys()] });
  return def;
}

export function listActions(): ActionDef[] {
  return [...registry.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function parseArgs<S extends z.ZodType>(def: ActionDef<S>, args: unknown): z.infer<S> {
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new BodyError(ErrorCodes.BAD_REQUEST, `invalid arguments for ${def.name}: ${issues}`);
  }
  return parsed.data;
}

export function buildManifest(): ActionManifestEntry[] {
  return listActions().map((def) => ({
    name: def.name,
    description: def.description,
    params: z.toJSONSchema(def.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
    category: def.category,
    longRunning: def.longRunning,
  }));
}

/**
 * Human/LLM readable documentation of the skill API (`api.<action>(args)`), generated from the
 * registry so it never drifts from the implementation.
 */
export function buildSkillApiDoc(): string {
  const lines: string[] = [
    '# EMETH skill API',
    '',
    'A skill is JavaScript: `async function main(api, args) { ... }`. `api` exposes every body primitive as an async',
    'function taking one object argument and returning a result (or throwing a BodyError with a `.code`).',
    'Helpers: `api.log(...)`, `api.sleep(ms)`, `api.Vec3(x,y,z)`, `api.observe()`, `api.distance(a,b)`.',
    'Rules: no `require`/`import`/`process`/`globalThis`/`eval`; keep loops bounded; check `api.aborted()` in long loops.',
    '',
  ];
  let currentCategory = '';
  for (const def of listActions()) {
    if (def.category !== currentCategory) {
      currentCategory = def.category;
      lines.push(`## ${currentCategory}`, '');
    }
    const schema = z.toJSONSchema(def.schema, { target: 'draft-7', io: 'input' }) as {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const params = Object.entries(props)
      .map(([k, v]) => {
        const type = (v.type as string | undefined) ?? (Array.isArray(v.anyOf) ? 'any' : 'object');
        const def_ = v.default !== undefined ? ` = ${JSON.stringify(v.default)}` : '';
        const desc = v.description ? ` — ${v.description}` : '';
        return `  - ${k}${required.has(k) ? '' : '?'}: ${type}${def_}${desc}`;
      })
      .join('\n');
    lines.push(`### api.${def.name}(args)`, def.description, params ? `Parameters:\n${params}` : 'Parameters: none', '');
  }
  return lines.join('\n');
}

/** Test helper: wipe the registry (used by unit tests that register fake actions). */
export function __resetRegistry(): void {
  registry.clear();
}
