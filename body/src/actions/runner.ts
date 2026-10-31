/**
 * ActionRunner — serialises motor commands.
 *
 * The body has one pair of hands: exactly one deliberate action (primitive or skill) runs at a time.
 * Reflexes (motor/reflexes.ts) may interrupt the current action; the mind is told why through the
 * `interruptedBy` field of the result and an `action.interrupted` event.
 */
import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import type { Observer } from '../perception/observer.js';
import { BodyError, ErrorCodes, type ActionRequest, type ActionResult, type Observation } from '../protocol.js';
import { getLogger, type Logger } from '../util/logger.js';
import { raceAbort } from '../util/async.js';
import { getAction, parseArgs, type ActionContext } from './registry.js';

export interface RunnerEvents {
  progress: (payload: { id: string; action: string; message: string; data?: Record<string, unknown> }) => void;
  interrupted: (payload: { id: string; action: string; reason: string }) => void;
  started: (payload: { id: string; action: string }) => void;
  finished: (result: ActionResult) => void;
}

type Listener<K extends keyof RunnerEvents> = RunnerEvents[K];

export interface Running {
  id: string;
  name: string;
  startedAt: number;
  controller: AbortController;
  /** 'action' for primitives, 'skill' for sandboxed code */
  kind: 'action' | 'skill';
  /** Reflexes with lower priority than this cannot interrupt it. */
  priority: number;
}

export class ActionRunner {
  private current: Running | null = null;
  private readonly listeners: { [K in keyof RunnerEvents]: Set<Listener<K>> } = {
    progress: new Set(),
    interrupted: new Set(),
    started: new Set(),
    finished: new Set(),
  };
  private readonly log: Logger;

  constructor(
    private readonly bot: Bot,
    private readonly observer: Observer,
  ) {
    this.log = getLogger('runner');
    observer.setCurrentActionGetter(() => this.describeCurrent());
  }

  on<K extends keyof RunnerEvents>(event: K, fn: Listener<K>): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  private emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): void {
    for (const fn of this.listeners[event]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        this.log.error({ err }, 'listener failed');
      }
    }
  }

  isBusy(): boolean {
    return this.current !== null;
  }

  describeCurrent(): Observation['action'] {
    if (!this.current) return null;
    return { id: this.current.id, name: this.current.name, startedAt: this.current.startedAt };
  }

  /** Interrupt whatever runs. Returns true when something was running. */
  interrupt(reason: string, minPriority = 0): boolean {
    const cur = this.current;
    if (!cur) return false;
    if (cur.priority > minPriority) return false;
    this.log.info({ id: cur.id, name: cur.name, reason }, 'interrupting');
    cur.controller.abort(reason);
    this.emit('interrupted', { id: cur.id, action: cur.name, reason });
    return true;
  }

  /**
   * Acquire the hands for a custom task (used by the skill sandbox). Throws BUSY when occupied.
   */
  acquire(name: string, kind: Running['kind'], priority = 0): Running {
    if (this.current) {
      throw new BodyError(ErrorCodes.BUSY, `already busy with ${this.current.name} (${this.current.id}); call stop first`, {
        current: this.describeCurrent(),
      });
    }
    const running: Running = { id: randomUUID(), name, startedAt: Date.now(), controller: new AbortController(), kind, priority };
    this.current = running;
    this.emit('started', { id: running.id, action: name });
    return running;
  }

  release(running: Running): void {
    if (this.current && this.current.id === running.id) this.current = null;
  }

  makeContext(running: Running): ActionContext {
    return {
      bot: this.bot,
      observer: this.observer,
      signal: running.controller.signal,
      log: this.log.child({ action: running.name, id: running.id }),
      progress: (message, data) => this.emit('progress', { id: running.id, action: running.name, message, data }),
    };
  }

  /** Run a registered primitive. */
  async run(req: ActionRequest, priority = 0): Promise<ActionResult> {
    const def = getAction(req.action);
    const args = parseArgs(def, req.args);
    // `stop` must work even while busy
    if (def.name === 'stop') {
      this.interrupt('stop requested', Number.POSITIVE_INFINITY);
      const tmp: Running = { id: randomUUID(), name: 'stop', startedAt: Date.now(), controller: new AbortController(), kind: 'action', priority: 100 };
      const result = await def.run(this.makeContext(tmp), args);
      return { id: tmp.id, action: 'stop', ok: true, result, startedAt: tmp.startedAt, finishedAt: Date.now() };
    }
    // a dead body cannot finish anything: `respawn` replaces whatever still holds the hands (seen live: a flee reflex
    // that outlived the death made the respawn BUSY, and the body stayed on the death screen for hours)
    if (def.name === 'respawn' && this.current) this.interrupt('respawning', Number.POSITIVE_INFINITY);
    if (def.name === 'respawn' && this.current) this.current = null;
    const running = this.acquire(def.name, 'action', priority);
    const ctx = this.makeContext(running);
    const timeoutMs = req.timeoutMs ?? def.defaultTimeoutMs ?? (def.longRunning ? 180_000 : 30_000);
    let result: ActionResult;
    try {
      const value = await raceAbort(def.run(ctx, args), running.controller.signal, {
        timeoutMs,
        onCancel: () => {
          // give the primitive a chance to clean up through its signal; movement stops are idempotent
          try {
            this.bot.pathfinder?.stop();
            this.bot.pathfinder?.setGoal(null);
          } catch {
            /* ignore */
          }
        },
        timeoutMessage: `${def.name} exceeded ${timeoutMs}ms`,
      });
      result = { id: running.id, action: def.name, ok: true, result: value, startedAt: running.startedAt, finishedAt: Date.now() };
    } catch (err) {
      const e = err instanceof BodyError ? err : new BodyError(ErrorCodes.INTERNAL, (err as Error)?.message ?? String(err));
      result = {
        id: running.id,
        action: def.name,
        ok: false,
        error: e.message,
        errorCode: e.code,
        startedAt: running.startedAt,
        finishedAt: Date.now(),
        ...(running.controller.signal.aborted ? { interruptedBy: String(running.controller.signal.reason ?? 'aborted') } : {}),
      };
      if (e.data !== undefined) result.result = e.data;
    } finally {
      this.release(running);
    }
    this.emit('finished', result);
    return result;
  }
}
