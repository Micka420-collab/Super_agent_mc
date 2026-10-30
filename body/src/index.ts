/**
 * EMETH body entry point.
 *
 *   MC_HOST=127.0.0.1 MC_PORT=25565 MC_USERNAME=Emeth npm run dev
 *
 * Connects to the Minecraft server, exposes the bridge on BRIDGE_PORT and keeps the body alive
 * (reconnecting with backoff when the connection drops).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './config.js';
import { initLogger } from './util/logger.js';
import './actions/index.js';
import { createBody, type BodyRuntime } from './bot.js';
import { BridgeServer } from './bridge/server.js';
import { createVision } from './vision/index.js';

function bodyVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = initLogger(config.LOG_LEVEL);
  log.info({ host: config.MC_HOST, port: config.MC_PORT, username: config.MC_USERNAME, auth: config.MC_AUTH }, 'EMETH body starting');

  let runtime: BodyRuntime = createBody(config);
  let bridge: BridgeServer | null = null;
  let reconnectDelay = 5_000;
  let stopping = false;

  const wire = async (rt: BodyRuntime): Promise<void> => {
    const vision = await createVision(rt.bot, rt.observer, config.VISION_MODE);
    if (!bridge) {
      bridge = new BridgeServer({
        bot: rt.bot,
        observer: rt.observer,
        runner: rt.runner,
        reflexes: rt.reflexes,
        vision,
        config: { host: config.BRIDGE_HOST, port: config.BRIDGE_PORT, token: config.BRIDGE_TOKEN, observationHz: config.BRIDGE_OBSERVATION_HZ, mcHost: config.MC_HOST, mcPort: config.MC_PORT },
        bodyVersion: bodyVersion(),
      });
      bridge.start();
    } else {
      // swap the live bot into the existing bridge after a reconnect
      bridge.setRuntime({ bot: rt.bot, observer: rt.observer, runner: rt.runner, reflexes: rt.reflexes, vision });
    }
    rt.onEvent((event, payload) => bridge?.emit(event, payload));
    rt.bot.once('spawn', () => {
      reconnectDelay = 5_000;
    });
    rt.bot.once('end', () => {
      if (stopping) return;
      log.warn({ delayMs: reconnectDelay }, 'connection lost — reconnecting');
      setTimeout(() => {
        runtime = createBody(config);
        void wire(runtime);
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 120_000);
    });
  };

  await wire(runtime);

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    try {
      runtime.bot.quit('shutdown');
    } catch {
      /* ignore */
    }
    bridge?.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error({ reason }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => log.error({ err }, 'uncaught exception'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
