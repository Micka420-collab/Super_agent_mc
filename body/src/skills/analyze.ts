/**
 * Static analysis of LLM-generated skill code — the first of three safety layers
 * (analysis → worker thread → vm context).
 */
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import type { SkillCheckResult } from '../protocol.js';

export const FORBIDDEN_IDENTIFIERS = new Set([
  'require',
  'process',
  'globalThis',
  'global',
  'eval',
  'Function',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'SharedArrayBuffer',
  'Atomics',
  'WebAssembly',
  'setInterval',
  'setTimeout',
  'setImmediate',
  'queueMicrotask',
  'Reflect',
  'Proxy',
  'importScripts',
  'postMessage',
]);

export const FORBIDDEN_PROPERTIES = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

export interface AnalyzeOptions {
  /** Names available on `api`; calls to anything else are reported. */
  knownApi?: Set<string>;
  maxLength?: number;
}

export function analyzeSkill(code: string, opts: AnalyzeOptions = {}): SkillCheckResult {
  const problems: string[] = [];
  const apiCalls = new Set<string>();
  const maxLength = opts.maxLength ?? 200_000;
  if (code.length > maxLength) problems.push(`code too long (${code.length} > ${maxLength})`);

  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: false, locations: true });
  } catch (err) {
    return { ok: false, problems: [`syntax error: ${(err as Error).message}`], apiCalls: [] };
  }

  let hasMain = false;
  walk.full(ast, (node) => {
    const n = node as acorn.Node & Record<string, unknown>;
    switch (n.type) {
      case 'FunctionDeclaration': {
        const id = n.id as { name?: string } | null;
        if (id?.name === 'main') {
          hasMain = true;
          if (!n.async) problems.push('`main` must be declared `async function main(api, args)`');
        }
        break;
      }
      case 'Identifier': {
        const name = n.name as string;
        if (FORBIDDEN_IDENTIFIERS.has(name)) problems.push(`forbidden identifier \`${name}\` at line ${(n.loc as acorn.SourceLocation | undefined)?.start.line}`);
        break;
      }
      case 'MemberExpression': {
        const prop = n.property as acorn.Node & { name?: string; value?: unknown };
        const propName = n.computed ? (prop.type === 'Literal' ? String(prop.value) : null) : prop.name ?? null;
        if (propName && FORBIDDEN_PROPERTIES.has(propName)) {
          problems.push(`forbidden property access \`.${propName}\` at line ${(n.loc as acorn.SourceLocation | undefined)?.start.line}`);
        }
        const obj = n.object as acorn.Node & { name?: string };
        if (obj.type === 'Identifier' && obj.name === 'api' && propName) apiCalls.add(propName);
        break;
      }
      case 'ImportDeclaration':
      case 'ImportExpression':
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
        problems.push(`\`${n.type}\` is not allowed in skills`);
        break;
      case 'WithStatement':
        problems.push('`with` statements are not allowed');
        break;
      case 'MetaProperty':
        problems.push('`import.meta` / `new.target` are not allowed');
        break;
      case 'TaggedTemplateExpression':
        break;
      default:
        break;
    }
  });

  if (!hasMain) problems.push('skill must define `async function main(api, args)`');
  if (opts.knownApi) {
    const helpers = new Set(['log', 'sleep', 'Vec3', 'observe', 'distance', 'aborted', 'now', 'args']);
    for (const c of apiCalls) {
      if (!opts.knownApi.has(c) && !helpers.has(c)) problems.push(`unknown api function \`api.${c}\``);
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], apiCalls: [...apiCalls].sort() };
}
