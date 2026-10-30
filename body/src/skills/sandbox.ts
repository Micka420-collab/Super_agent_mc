/**
 * Skill sandbox (main-thread side): static analysis, worker lifecycle, primitive dispatch, trace.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ActionRunner } from '../actions/runner.js';
import { getAction, listActions, parseArgs } from '../actions/registry.js';
import { BodyError, ErrorCodes, type SkillCheckResult, type SkillRunRequest, type SkillRunResult } from '../protocol.js';
import { getLogger } from '../util/logger.js';
import { analyzeSkill } from './analyze.js';

const log = getLogger('skills');

export function knownApiNames(): Set<string> {
  return new Set(listActions().map((a) => a.name));
}

/** Top-level argument keys each primitive accepts, derived from its zod schema (object schemas only). */
export function knownApiArgKeys(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const a of listActions()) {
    const shape = (a.schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (shape && typeof shape === 'object') out.set(a.name, new Set(Object.keys(shape)));
  }
  return out;
}

export function checkSkill(code: string): SkillCheckResult {
  return analyzeSkill(code, { knownApi: knownApiNames(), apiArgKeys: knownApiArgKeys() });
}

function workerPath(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here); // .ts under tsx, .js when compiled
  return path.join(path.dirname(here), `worker${ext}`);
}

export interface SkillRunOptions {
  /** Hard wall-clock budget for the whole skill. */
  timeoutMs: number;
  /** Per-primitive budget (defaults mirror the runner). */
  callTimeoutMs?: number;
}

export async function runSkill(req: SkillRunRequest, runner: ActionRunner): Promise<SkillRunResult> {
  const check = checkSkill(req.code);
  const startedAt = Date.now();
  if (!check.ok) {
    throw new BodyError(ErrorCodes.SANDBOX_REJECTED, `skill rejected: ${check.problems.join('; ')}`, { problems: check.problems });
  }

  const running = runner.acquire(`skill:${req.name}`, 'skill');
  const ctx = runner.makeContext(running);
  const logs: string[] = [];
  const trace: SkillRunResult['trace'] = [];
  const apiNames = [...knownApiNames()];

  const worker = new Worker(workerPath(), {
    workerData: { code: req.code, args: req.args, apiNames, name: req.name },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    // inherit tsx loader when running from sources
    execArgv: process.execArgv,
  });

  let finished = false;
  const outcome = new Promise<SkillRunResult>((resolve) => {
    const finish = (partial: Pick<SkillRunResult, 'ok' | 'result' | 'error' | 'errorCode'>) => {
      if (finished) return;
      finished = true;
      clearTimeout(budget);
      resolve({
        id: running.id,
        name: req.name,
        ...partial,
        logs,
        trace,
        startedAt,
        finishedAt: Date.now(),
        ...(running.controller.signal.aborted ? { interruptedBy: String(running.controller.signal.reason ?? 'aborted') } : {}),
      });
    };

    const budget = setTimeout(() => {
      log.warn({ skill: req.name }, 'skill exceeded its time budget — terminating worker');
      void worker.terminate();
      finish({ ok: false, error: `skill exceeded ${req.timeoutMs}ms`, errorCode: ErrorCodes.TIMEOUT });
    }, req.timeoutMs);

    const onAbort = () => {
      worker.postMessage({ type: 'abort', reason: String(running.controller.signal.reason ?? 'aborted') });
      // give primitives a moment to unwind, then hard-kill
      setTimeout(() => {
        if (!finished) {
          void worker.terminate();
          finish({ ok: false, error: `interrupted: ${String(running.controller.signal.reason ?? 'aborted')}`, errorCode: ErrorCodes.INTERRUPTED });
        }
      }, 1_500);
    };
    running.controller.signal.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (msg: { type: string; [k: string]: unknown }) => {
      switch (msg.type) {
        case 'log': {
          if (logs.length < 500) logs.push(String(msg.message));
          break;
        }
        case 'call': {
          void handleCall(msg as unknown as { callId: number; name: string; args: unknown });
          break;
        }
        case 'done':
          finish({ ok: true, result: msg.result });
          break;
        case 'error':
          finish({ ok: false, error: String(msg.message), errorCode: (msg.code as string | undefined) ?? ErrorCodes.SKILL_ERROR });
          break;
        default:
          break;
      }
    });
    worker.on('error', (err) => finish({ ok: false, error: `worker crashed: ${err.message}`, errorCode: ErrorCodes.SKILL_ERROR }));
    worker.on('exit', (code) => {
      if (!finished) finish({ ok: false, error: `worker exited with code ${code}`, errorCode: ErrorCodes.SKILL_ERROR });
    });

    async function handleCall(call: { callId: number; name: string; args: unknown }): Promise<void> {
      const t0 = Date.now();
      try {
        const def = getAction(call.name);
        if (def.name === 'stop') throw new BodyError(ErrorCodes.BAD_REQUEST, 'skills cannot call stop; just return');
        const args = parseArgs(def, call.args);
        const result = await def.run(ctx, args);
        trace.push({ t: t0 - startedAt, call: call.name, ok: true, ms: Date.now() - t0 });
        if (!finished) worker.postMessage({ type: 'callResult', callId: call.callId, ok: true, result: JSON.parse(JSON.stringify(result ?? null)) });
      } catch (err) {
        const e = err instanceof BodyError ? err : new BodyError(ErrorCodes.INTERNAL, (err as Error)?.message ?? String(err));
        trace.push({ t: t0 - startedAt, call: call.name, ok: false, ms: Date.now() - t0, error: e.message });
        if (!finished) worker.postMessage({ type: 'callResult', callId: call.callId, ok: false, error: e.message, code: e.code });
      }
    }
  });

  try {
    return await outcome;
  } finally {
    runner.release(running);
    void worker.terminate();
  }
}
