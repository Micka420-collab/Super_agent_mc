import pino from 'pino';

export type Logger = pino.Logger;

let root: Logger | null = null;

export function initLogger(level: string): Logger {
  root = pino({
    level,
    base: { service: 'emeth-body' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return root;
}

export function getLogger(component?: string): Logger {
  if (!root) root = initLogger(process.env.LOG_LEVEL ?? 'info');
  return component ? root.child({ component }) : root;
}
