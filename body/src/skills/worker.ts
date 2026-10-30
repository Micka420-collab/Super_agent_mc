/**
 * Skill worker — runs LLM-generated code in a worker thread + vm context.
 *
 * The worker never touches the bot. Every `api.<primitive>(args)` call is forwarded to the main
 * thread over the message port and awaited; the main thread executes it with the real bot and
 * replies. A skill stuck in a synchronous infinite loop cannot block the body: the main thread
 * terminates the worker when its budget expires.
 */
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

interface RunMessage {
  code: string;
  args: Record<string, unknown>;
  apiNames: string[];
  name: string;
}

type OutMessage =
  | { type: 'call'; callId: number; name: string; args: unknown }
  | { type: 'log'; message: string }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string; stack?: string; code?: string };

type InMessage = { type: 'callResult'; callId: number; ok: boolean; result?: unknown; error?: string; code?: string };

if (!parentPort) throw new Error('skill worker must run inside a worker thread');
const port = parentPort;
const data = workerData as RunMessage;

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextCallId = 1;
let aborted = false;

// NOTE: this file is executed by Node's native type stripping when running from sources, so it must
// only use erasable TypeScript syntax (no enums, no parameter properties, no namespaces).
class SkillApiError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SkillApiError';
    this.code = code;
  }
}

function send(msg: OutMessage): void {
  port.postMessage(msg);
}

function call(name: string, args: unknown): Promise<unknown> {
  if (aborted) return Promise.reject(new SkillApiError('skill aborted', 'INTERRUPTED'));
  const callId = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    send({ type: 'call', callId, name, args: args ?? {} });
  });
}

port.on('message', (msg: InMessage | { type: 'abort'; reason?: string }) => {
  if (msg.type === 'abort') {
    aborted = true;
    for (const [, p] of pending) p.reject(new SkillApiError(`skill aborted: ${msg.reason ?? ''}`, 'INTERRUPTED'));
    pending.clear();
    return;
  }
  if (msg.type === 'callResult') {
    const p = pending.get(msg.callId);
    if (!p) return;
    pending.delete(msg.callId);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new SkillApiError(msg.error ?? 'unknown error', msg.code ?? 'SKILL_ERROR'));
  }
});

// ----- Build the frozen api facade -----------------------------------------------------------
const api: Record<string, unknown> = Object.create(null);
for (const name of data.apiNames) {
  api[name] = (args?: unknown) => call(name, args);
}
api['log'] = (...parts: unknown[]) => {
  send({ type: 'log', message: parts.map((p) => (typeof p === 'string' ? p : safeStringify(p))).join(' ') });
};
api['sleep'] = (ms: number) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, Math.max(0, Math.min(Number(ms) || 0, 300_000)));
    const check = setInterval(() => {
      if (aborted) {
        clearTimeout(t);
        clearInterval(check);
        reject(new SkillApiError('skill aborted', 'INTERRUPTED'));
      }
    }, 100);
    setTimeout(() => clearInterval(check), Math.max(0, Math.min(Number(ms) || 0, 300_000)) + 1);
  });
api['Vec3'] = (x: number, y: number, z: number) => ({ x, y, z });
api['observe'] = (detail?: 'compact' | 'full') => call('observe', { detail: detail ?? 'compact' });
api['distance'] = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
api['aborted'] = () => aborted;
api['now'] = () => Date.now();
api['args'] = data.args;
Object.freeze(api);

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ----- Run -----------------------------------------------------------------------------------
async function main(): Promise<void> {
  const sandbox: Record<string, unknown> = Object.create(null);
  sandbox['console'] = Object.freeze({ log: api['log'], info: api['log'], warn: api['log'], error: api['log'] });
  const context = vm.createContext(sandbox, { name: `skill:${data.name}`, codeGeneration: { strings: false, wasm: false } });
  const wrapped = `${data.code}\n;(typeof main === 'function' ? main : null)`;
  let fn: unknown;
  try {
    fn = new vm.Script(wrapped, { filename: `skill-${data.name}.js` }).runInContext(context, { timeout: 2_000 });
  } catch (err) {
    send({ type: 'error', message: `failed to load skill: ${(err as Error).message}`, stack: (err as Error).stack, code: 'SANDBOX_REJECTED' });
    return;
  }
  if (typeof fn !== 'function') {
    send({ type: 'error', message: 'skill does not define main(api, args)', code: 'SANDBOX_REJECTED' });
    return;
  }
  try {
    const result = await (fn as (api: unknown, args: unknown) => Promise<unknown>)(api, data.args);
    send({ type: 'done', result: JSON.parse(safeStringify(result ?? null)) });
  } catch (err) {
    const e = err as Error & { code?: string };
    send({ type: 'error', message: e?.message ?? String(err), stack: e?.stack, code: e?.code ?? 'SKILL_ERROR' });
  }
}

void main();
