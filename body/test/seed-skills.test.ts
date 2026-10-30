import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/actions/index.js';
import { checkSkill } from '../src/skills/sandbox.js';
import { parseSkillHeader } from './helpers/skillHeader.js';

const LIB = path.resolve(__dirname, '..', '..', 'skills', 'library');

describe('seed skills', () => {
  const files = readdirSync(LIB).filter((f) => f.endsWith('.js') && !f.includes('.v') && !f.includes('.retired'));
  it('exist', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });
  for (const file of files) {
    it(`${file} passes static analysis against the live primitive registry`, () => {
      const code = readFileSync(path.join(LIB, file), 'utf8');
      const res = checkSkill(code);
      expect(res.ok, res.problems.join('; ')).toBe(true);
      expect(res.apiCalls.length).toBeGreaterThan(0);
      const header = parseSkillHeader(code);
      expect(header.name).toBe(path.basename(file, '.js'));
      expect(header.description.length).toBeGreaterThan(20);
    });
  }
});
