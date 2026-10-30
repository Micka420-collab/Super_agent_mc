import { describe, expect, it } from 'vitest';
import { analyzeSkill } from '../src/skills/analyze.js';

const known = new Set(['mine', 'craft', 'goto', 'say']);

describe('skill static analysis', () => {
  it('accepts a well-formed skill', () => {
    const res = analyzeSkill(
      `async function main(api, args) {
        const r = await api.mine({ name: 'oak_log', count: args.count ?? 3 });
        api.log('mined', r);
        await api.craft({ name: 'oak_planks', count: 4 });
        return r;
      }`,
      { knownApi: known },
    );
    expect(res.ok).toBe(true);
    expect(res.apiCalls).toEqual(['craft', 'log', 'mine']);
  });

  it('rejects dangerous identifiers and property chains', () => {
    const res = analyzeSkill(
      `async function main(api) {
        const fs = require('fs');
        process.exit(1);
        const f = [].constructor.constructor('return this')();
        globalThis.x = 1;
      }`,
      { knownApi: known },
    );
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/require/);
    expect(res.problems.join('\n')).toMatch(/process/);
    expect(res.problems.join('\n')).toMatch(/constructor/);
    expect(res.problems.join('\n')).toMatch(/globalThis/);
  });

  it('rejects imports, missing main and unknown api functions', () => {
    expect(analyzeSkill(`import fs from 'fs'; async function main(api){}`).ok).toBe(false);
    const noMain = analyzeSkill(`async function helper(api){}`);
    expect(noMain.problems.join()).toMatch(/must define/);
    const notAsync = analyzeSkill(`function main(api){}`);
    expect(notAsync.problems.join()).toMatch(/async/);
    const unknown = analyzeSkill(`async function main(api){ await api.teleport({}); }`, { knownApi: known });
    expect(unknown.problems.join()).toMatch(/unknown api function `api.teleport`/);
  });

  it('reports syntax errors instead of throwing', () => {
    const res = analyzeSkill('async function main(api { oops');
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toMatch(/syntax error/);
  });
});
