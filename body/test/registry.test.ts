import { describe, expect, it } from 'vitest';
import '../src/actions/index.js';
import { buildManifest, buildSkillApiDoc, getAction, listActions, parseArgs } from '../src/actions/registry.js';
import { ActionManifestEntrySchema, ErrorCodes } from '../src/protocol.js';

describe('action registry', () => {
  it('registers the full primitive vocabulary', () => {
    const names = listActions().map((a) => a.name);
    for (const expected of ['goto', 'mine', 'craft', 'smelt', 'plan_get', 'get', 'shear', 'place', 'plan_build', 'build', 'attack', 'eat', 'sleep', 'say', 'whisper', 'find_blocks', 'observe', 'stop', 'explore', 'follow', 'container_deposit', 'write_book']) {
      expect(names).toContain(expected);
    }
    expect(names.length).toBeGreaterThanOrEqual(40);
  });

  it('produces a manifest that validates against the protocol schema', () => {
    const manifest = buildManifest();
    for (const entry of manifest) {
      const parsed = ActionManifestEntrySchema.safeParse(entry);
      expect(parsed.success, `${entry.name}: ${JSON.stringify(parsed.success ? '' : parsed.error.issues)}`).toBe(true);
      expect((entry.params as { type?: string }).type).toBe('object');
    }
  });

  it('generates skill API docs from the same source of truth', () => {
    const doc = buildSkillApiDoc();
    expect(doc).toContain('### api.mine(args)');
    expect(doc).toContain('### api.craft(args)');
    expect(doc).toContain('- count?: integer = 1');
  });

  it('validates arguments and reports useful errors', () => {
    const goto = getAction('goto');
    expect(parseArgs(goto, { x: 1, y: 64, z: 2 })).toMatchObject({ x: 1, y: 64, z: 2, range: 1 });
    expect(() => parseArgs(goto, { x: 'a' })).toThrow(/invalid arguments for goto/);
    try {
      getAction('teleport');
    } catch (err) {
      expect((err as { code: string }).code).toBe(ErrorCodes.UNKNOWN_ACTION);
    }
  });
});
