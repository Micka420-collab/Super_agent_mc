import { describe, expect, it, beforeAll } from 'vitest';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { __resetRegistry, defineAction } from '../src/actions/registry.js';
import { ActionRunner } from '../src/actions/runner.js';
import { Observer } from '../src/perception/observer.js';
import { runSkill } from '../src/skills/sandbox.js';
import { sleep } from '../src/util/async.js';
import { ErrorCodes } from '../src/protocol.js';

function fakeRunner(): ActionRunner {
  const bot = { pathfinder: { stop() {}, setGoal() {} }, clearControlStates() {} } as unknown as Bot;
  const observer = new Observer(bot);
  return new ActionRunner(bot, observer);
}

beforeAll(() => {
  __resetRegistry();
  defineAction({
    name: 'echo',
    category: 'meta',
    description: 'echo',
    longRunning: false,
    schema: z.object({ value: z.unknown() }),
    async run(_ctx, a) {
      return { echoed: a.value };
    },
  });
  defineAction({
    name: 'slow',
    category: 'meta',
    description: 'slow',
    longRunning: true,
    schema: z.object({ ms: z.number().default(200) }),
    async run(ctx, a) {
      await sleep(a.ms, ctx.signal);
      return { slept: a.ms };
    },
  });
  defineAction({
    name: 'boom',
    category: 'meta',
    description: 'throws',
    longRunning: false,
    schema: z.object({}),
    async run() {
      throw new Error('kaboom');
    },
  });
});

describe('skill sandbox', () => {
  it('runs a skill in a worker and proxies api calls with a trace', async () => {
    const runner = fakeRunner();
    const res = await runSkill(
      {
        name: 'echo_twice',
        code: `async function main(api, args) {
          const a = await api.echo({ value: args.x });
          api.log('first', JSON.stringify(a));
          const b = await api.echo({ value: a.echoed * 2 });
          return { a, b, pos: api.Vec3(1,2,3), d: api.distance({x:0,y:0,z:0},{x:3,y:4,z:0}) };
        }`,
        args: { x: 21 },
        timeoutMs: 10_000,
      },
      runner,
    );
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ a: { echoed: 21 }, b: { echoed: 42 }, pos: { x: 1, y: 2, z: 3 }, d: 5 });
    expect(res.logs).toEqual(['first {"echoed":21}']);
    expect(res.trace.map((t) => t.call)).toEqual(['echo', 'echo']);
    expect(runner.isBusy()).toBe(false);
  });

  it('rejects unsafe code before running anything', async () => {
    const runner = fakeRunner();
    await expect(
      runSkill({ name: 'evil', code: `async function main(api){ process.exit(1) }`, args: {}, timeoutMs: 5_000 }, runner),
    ).rejects.toMatchObject({ code: ErrorCodes.SANDBOX_REJECTED });
    expect(runner.isBusy()).toBe(false);
  });

  it('surfaces primitive errors to the skill as catchable exceptions with codes', async () => {
    const runner = fakeRunner();
    const res = await runSkill(
      {
        name: 'catcher',
        code: `async function main(api) {
          try { await api.boom({}); return 'no error'; }
          catch (e) { return { caught: e.message, code: e.code }; }
        }`,
        args: {},
        timeoutMs: 5_000,
      },
      runner,
    );
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ caught: 'kaboom', code: 'INTERNAL' });
    expect(res.trace[0]?.ok).toBe(false);
  });

  it('kills a skill stuck in a synchronous infinite loop when the budget expires', async () => {
    const runner = fakeRunner();
    const res = await runSkill({ name: 'spin', code: `async function main(api){ while (true) {} }`, args: {}, timeoutMs: 1_500 }, runner);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.TIMEOUT);
    expect(runner.isBusy()).toBe(false);
  });

  it('can be interrupted by a reflex while awaiting a primitive', async () => {
    const runner = fakeRunner();
    const promise = runSkill({ name: 'patient', code: `async function main(api){ await api.slow({ ms: 5000 }); return 'done'; }`, args: {}, timeoutMs: 20_000 }, runner);
    await sleep(300);
    expect(runner.isBusy()).toBe(true);
    expect(runner.interrupt('reflex:test', 50)).toBe(true);
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.interruptedBy).toContain('reflex:test');
    expect(runner.isBusy()).toBe(false);
  });

  it('refuses to start while the hands are busy', async () => {
    const runner = fakeRunner();
    const first = runSkill({ name: 'first', code: `async function main(api){ await api.slow({ ms: 800 }); return 1; }`, args: {}, timeoutMs: 5_000 }, runner);
    await sleep(150);
    await expect(runSkill({ name: 'second', code: `async function main(api){ return 2; }`, args: {}, timeoutMs: 5_000 }, runner)).rejects.toMatchObject({ code: ErrorCodes.BUSY });
    const res = await first;
    expect(res.ok).toBe(true);
  });
});
