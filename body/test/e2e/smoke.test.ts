/**
 * End-to-end smoke test against a real (JavaScript) Minecraft server: flying-squid, MC 1.21.1,
 * superflat creative world. Exercises the body: spawn → observe → primitives → skill sandbox → bridge.
 *
 *   npm run test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { Vec3 } from 'vec3';
import { loadConfig } from '../../src/config.js';
import '../../src/actions/index.js';
import { createBody, type BodyRuntime } from '../../src/bot.js';
import { BridgeServer } from '../../src/bridge/server.js';
import { createVision } from '../../src/vision/index.js';
import { ObservationSchema, HelloResultSchema, ActionResultSchema, type ResponseEnvelope } from '../../src/protocol.js';
import { runSkill } from '../../src/skills/sandbox.js';

const require = createRequire(import.meta.url);
const MC_VERSION = '1.21.1';
const PORT = 25600 + Math.floor(Math.random() * 300);
const BRIDGE_PORT = PORT + 1000;

let server: { quit: (reason?: string) => Promise<void>; on: (e: string, cb: (...a: unknown[]) => void) => void } | null = null;
let runtime: BodyRuntime | null = null;
let bridge: BridgeServer | null = null;

async function rpc(ws: WebSocket, method: string, params?: unknown): Promise<ResponseEnvelope> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ResponseEnvelope & { kind: string };
      if (msg.kind === 'response' && msg.id === id) {
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ kind: 'request', id, method, params }));
    setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 60_000);
  });
}

beforeAll(async () => {
  const mcServer = require('flying-squid') as { createMCServer: (o: Record<string, unknown>) => typeof server };
  server = mcServer.createMCServer({
    motd: 'EMETH e2e',
    port: PORT,
    'max-players': 5,
    'online-mode': false,
    logging: false,
    gameMode: 1,
    difficulty: 1,
    worldFolder: undefined,
    generation: { name: 'superflat', options: { worldHeight: 80 } },
    kickTimeout: 60_000,
    plugins: {},
    modpe: false,
    'view-distance': 6,
    'player-list-text': { header: 'EMETH', footer: 'e2e' },
    'everybody-op': true,
    'max-entities': 50,
    version: MC_VERSION,
  });
  await new Promise<void>((resolve) => server!.on('listening', () => resolve()));

  const config = loadConfig({
    MC_HOST: '127.0.0.1',
    MC_PORT: String(PORT),
    MC_USERNAME: 'Emeth',
    MC_VERSION,
    BRIDGE_PORT: String(BRIDGE_PORT),
    BRIDGE_TOKEN: 'secret',
    LOG_LEVEL: 'warn',
    REFLEX_ENABLED: 'true',
  });
  runtime = createBody(config);
  await new Promise<void>((resolve, reject) => {
    runtime!.bot.once('spawn', () => resolve());
    runtime!.bot.once('kicked', (r) => reject(new Error(`kicked: ${String(r)}`)));
    runtime!.bot.once('error', (e) => reject(e));
  });
  await runtime.bot.waitForChunksToLoad();
  const vision = await createVision(runtime.bot, runtime.observer, 'retina');
  bridge = new BridgeServer({
    bot: runtime.bot,
    observer: runtime.observer,
    runner: runtime.runner,
    reflexes: runtime.reflexes,
    vision,
    config: { host: '127.0.0.1', port: BRIDGE_PORT, token: 'secret', observationHz: 0, mcHost: '127.0.0.1', mcPort: PORT },
    bodyVersion: 'e2e',
  });
  bridge.start();
  runtime.onEvent((event, payload) => bridge?.emit(event, payload));
}, 120_000);

afterAll(async () => {
  bridge?.stop();
  try {
    runtime?.bot.quit();
  } catch {
    /* ignore */
  }
  await server?.quit('e2e done');
  await new Promise((r) => setTimeout(r, 500));
});

describe('body e2e (flying-squid)', () => {
  it('observes a schema-valid world after spawning', () => {
    const obs = runtime!.observer.observe('full');
    const parsed = ObservationSchema.safeParse(obs);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues).slice(0, 500)).toBe(true);
    expect(obs.blocks.standingOn).toBe('grass_block');
    expect(obs.vision?.visible.length).toBeGreaterThan(0);
    expect(obs.self.gameMode).toBeDefined();
  });

  it('runs perception, social and movement primitives', async () => {
    const runner = runtime!.runner;
    const found = await runner.run({ action: 'find_blocks', args: { names: ['grass_block'], maxDistance: 8, count: 5 } });
    expect(found.ok).toBe(true);
    expect((found.result as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0);

    const look = await runner.run({ action: 'look_at', args: { x: 0, y: 70, z: -100 } });
    expect(look.ok).toBe(true);

    const say = await runner.run({ action: 'say', args: { text: 'bonjour le monde' } });
    expect(say.ok).toBe(true);

    const before = runtime!.bot.entity.position.clone();
    const jump = await runner.run({ action: 'jump', args: {} });
    expect(jump.ok).toBe(true);
    const move = await runner.run({ action: 'move', args: { control: 'forward', ms: 600 } });
    expect(move.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(runtime!.bot.entity.position.distanceTo(before)).toBeGreaterThan(0.3);
  });

  it('walks to a target with the pathfinder', async () => {
    const bot = runtime!.bot;
    const start = bot.entity.position.clone();
    const target = start.offset(6, 0, 0);
    const res = await runtime!.runner.run({ action: 'goto', args: { x: target.x, y: target.y, z: target.z, range: 1.5, timeoutMs: 30_000 } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(bot.entity.position.distanceTo(target)).toBeLessThan(2.5);
  });

  it('digs a block from the world', async () => {
    const bot = runtime!.bot;
    const below = bot.entity.position.floored().offset(2, -1, 2);
    const res = await runtime!.runner.run({ action: 'dig', args: { x: below.x, y: below.y, z: below.z, collect: false } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(bot.blockAt(new Vec3(below.x, below.y, below.z))?.name).toBe('air');
  });

  it('places blocks and builds a small wall from creative inventory', async () => {
    const bot = runtime!.bot;
    const Item = createRequire(import.meta.url)('prismarine-item')(bot.registry) as new (id: number, count: number) => unknown;
    const stone = bot.registry.itemsByName['stone']!;
    const pickaxe = bot.registry.itemsByName['diamond_pickaxe']!;
    await bot.creative.setInventorySlot(36, new Item(stone.id, 64) as never);
    await bot.creative.setInventorySlot(37, new Item(pickaxe.id, 1) as never);
    await new Promise((r) => setTimeout(r, 200));
    expect(bot.inventory.items().some((i) => i.name === 'stone')).toBe(true);
    const base = bot.entity.position.floored();
    // single placement
    const single = await runtime!.runner.run({ action: 'place', args: { name: 'stone', x: base.x + 3, y: base.y, z: base.z + 3 } });
    expect(single.ok, JSON.stringify(single)).toBe(true);
    expect(bot.blockAt(new Vec3(base.x + 3, base.y, base.z + 3))?.name).toBe('stone');
    // a 3x2 wall, bottom-up
    const blocks = [];
    for (let dx = 0; dx < 3; dx++) for (let dy = 0; dy < 2; dy++) blocks.push({ name: 'stone', x: base.x - 3 + dx, y: base.y + dy, z: base.z - 3 });
    const wall = await runtime!.runner.run({ action: 'build', args: { blocks } });
    expect(wall.ok, JSON.stringify(wall)).toBe(true);
    const r = wall.result as { placed: number; failureCount: number; alreadyCorrect: number };
    expect(r.placed + r.alreadyCorrect).toBeGreaterThanOrEqual(5);
    expect(r.failureCount).toBeLessThanOrEqual(1);
    // idempotent: a second build reports the cells as already correct
    const again = await runtime!.runner.run({ action: 'build', args: { blocks } });
    expect((again.result as { alreadyCorrect: number }).alreadyCorrect).toBeGreaterThanOrEqual(5);
    // materials check fails loudly when the inventory lacks the block
    const missing = await runtime!.runner.run({ action: 'build', args: { blocks: [{ name: 'diamond_block', x: base.x, y: base.y + 5, z: base.z }] } });
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe('MISSING_ITEM');
    // survey tools see the new wall
    const region = await runtime!.runner.run({ action: 'scan_region', args: { min: { x: base.x - 3, y: base.y, z: base.z - 3 }, max: { x: base.x - 1, y: base.y + 1, z: base.z - 3 } } });
    expect((region.result as { counts: Record<string, number> }).counts['stone']).toBeGreaterThanOrEqual(5);
    const heights = await runtime!.runner.run({ action: 'surface_height', args: { x: base.x, z: base.z, radius: 4 } });
    expect((heights.result as { roughness: number }).roughness).toBeGreaterThanOrEqual(1);
    // clear it again
    const cleared = await runtime!.runner.run({ action: 'clear_area', args: { min: { x: base.x - 3, y: base.y, z: base.z - 3 }, max: { x: base.x - 1, y: base.y + 1, z: base.z - 3 } } });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect((cleared.result as { dug: number }).dug).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it('executes a sandboxed skill that uses the live api', async () => {
    const res = await runSkill(
      {
        name: 'look_around',
        code: `async function main(api, args) {
          const obs = await api.observe();
          await api.look_at({ x: obs.self.position.x + 5, y: obs.self.position.y + 1, z: obs.self.position.z });
          const found = await api.find_blocks({ names: ['grass_block'], maxDistance: 4, count: 3 });
          api.log('found', found.blocks.length);
          return { standingOn: obs.blocks.standingOn, found: found.blocks.length };
        }`,
        args: {},
        timeoutMs: 30_000,
      },
      runtime!.runner,
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect((res.result as { standingOn: string }).standingOn).toBe('grass_block');
    expect(res.trace.map((t) => t.call)).toEqual(['observe', 'look_at', 'find_blocks']);
  });

  it('serves the bridge: hello, observe, act, vision.render, auth', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const bad = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
        bad.on('close', (code) => resolve(code));
        bad.on('error', reject);
      }),
    ).resolves.toBe(4401);

    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}?token=secret`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    const hello = await rpc(ws, 'hello');
    expect(hello.ok).toBe(true);
    const parsedHello = HelloResultSchema.safeParse((hello as { result: unknown }).result);
    expect(parsedHello.success).toBe(true);
    expect(parsedHello.success && parsedHello.data.actions.length).toBeGreaterThan(30);

    const obs = await rpc(ws, 'observe', { detail: 'compact' });
    expect(obs.ok).toBe(true);
    expect(ObservationSchema.safeParse((obs as { result: unknown }).result).success).toBe(true);

    const act = await rpc(ws, 'act', { action: 'look_at', args: { x: 10, y: 64, z: 10 } });
    expect(act.ok).toBe(true);
    expect(ActionResultSchema.safeParse((act as { result: unknown }).result).success).toBe(true);

    const render = await rpc(ws, 'vision.render', { width: 32, height: 18 });
    expect(render.ok).toBe(true);
    expect((render as { result: { pngBase64: string } }).result.pngBase64.length).toBeGreaterThan(100);

    const bad = await rpc(ws, 'act', { action: 'teleport', args: {} });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error.code).toBe('UNKNOWN_ACTION');
    ws.close();
  });
});
