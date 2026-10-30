import { BodyError, ErrorCodes } from '../protocol.js';

export class AbortedError extends BodyError {
  constructor(reason = 'aborted') {
    super(ErrorCodes.INTERRUPTED, reason);
    this.name = 'AbortedError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
}

/** Sleep that resolves early (rejecting) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError(String(signal.reason ?? 'aborted')));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError(String(signal?.reason ?? 'aborted')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Race a promise against an abort signal and an optional timeout.
 * `onCancel` runs when the race is lost (abort or timeout) so callers can stop the underlying work.
 */
export async function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  opts: { timeoutMs?: number; onCancel?: () => void | Promise<void>; timeoutMessage?: string } = {},
): Promise<T> {
  if (signal?.aborted) {
    await opts.onCancel?.();
    throw new AbortedError(String(signal.reason ?? 'aborted'));
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  };
  const guard = new Promise<never>((_, reject) => {
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        void Promise.resolve(opts.onCancel?.()).finally(() =>
          reject(new BodyError(ErrorCodes.TIMEOUT, opts.timeoutMessage ?? `timed out after ${opts.timeoutMs}ms`)),
        );
      }, opts.timeoutMs);
    }
    if (signal) {
      onAbort = () => {
        void Promise.resolve(opts.onCancel?.()).finally(() => reject(new AbortedError(String(signal.reason ?? 'aborted'))));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    cleanup();
  }
}

/** Wait for a predicate to become true, polling every `intervalMs`. */
export async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal; message?: string },
): Promise<void> {
  const start = Date.now();
  const interval = opts.intervalMs ?? 100;
  while (!predicate()) {
    throwIfAborted(opts.signal);
    if (Date.now() - start > opts.timeoutMs) {
      throw new BodyError(ErrorCodes.TIMEOUT, opts.message ?? `condition not met within ${opts.timeoutMs}ms`);
    }
    await sleep(interval, opts.signal);
  }
}

export function once<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}
