/**
 * End-to-end smoke test against a real (JavaScript) Minecraft server: flying-squid, MC 1.21.1,
 * superflat creative world. Exercises the body: spawn → observe → primitives → skill sandbox → bridge.
 *
 *   npm run test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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

  it('digs a surveyed staircase down and a tunnel at the bottom, reporting where it stopped', async () => {
    const bot = runtime!.bot;
    const Item = createRequire(import.meta.url)('prismarine-item')(bot.registry) as new (id: number, count: number) => unknown;
    await bot.creative.setInventorySlot(37, new Item(bot.registry.itemsByName['diamond_pickaxe']!.id, 1) as never);
    await new Promise((r) => setTimeout(r, 200));
    const start = bot.entity.position.floored();
    const info = await runtime!.runner.run({ action: 'ore_info', args: { name: 'diamond' } });
    expect(info.ok, JSON.stringify(info)).toBe(true);
    expect((info.result as { advice: { move: string } }).advice.move).toBe('descend');

    const down = await runtime!.runner.run({ action: 'descend', args: { toY: start.y - 3, direction: 'west', torchEvery: 32, maxSteps: 3 } });
    expect(down.ok, JSON.stringify(down)).toBe(true);
    const d = down.result as { steps: number; reachedTarget: boolean; end: { x: number; y: number; z: number }; stoppedBecause: string; direction: string };
    expect(d.direction).toBe('west');
    expect(d.steps).toBe(3);
    expect(d.reachedTarget).toBe(true);
    expect(bot.entity.position.floored().y).toBe(start.y - 3);
    // the staircase really exists: each step's feet cell is open
    for (let i = 1; i <= 3; i++) expect(bot.blockAt(new Vec3(start.x - i, start.y - i, start.z))?.name).toBe('air');

    const along = await runtime!.runner.run({ action: 'tunnel', args: { length: 3, direction: 'west', torchEvery: 32 } });
    expect(along.ok, JSON.stringify(along)).toBe(true);
    const t = along.result as { steps: number; end: { x: number; y: number; z: number }; stoppedBecause: string };
    expect(t.steps).toBe(3);
    expect(t.end.x).toBe(d.end.x - 3);
    expect(bot.blockAt(new Vec3(t.end.x, t.end.y + 1, t.end.z))?.name).toBe('air');
    // walk back up to the surface for the rest of the suite
    const back = await runtime!.runner.run({ action: 'goto', args: { x: start.x + 0.5, y: start.y, z: start.z + 0.5, range: 1, timeoutMs: 30_000 } });
    expect(back.ok, JSON.stringify(back)).toBe(true);
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
    // a 3x2 wall, bottom-up — the dry run first: feasible, proven order, materials in hand; a floating block is refused
    const blocks = [];
    for (let dx = 0; dx < 3; dx++) for (let dy = 0; dy < 2; dy++) blocks.push({ name: 'stone', x: base.x - 3 + dx, y: base.y + dy, z: base.z - 3 });
    const dry = await runtime!.runner.run({ action: 'plan_build', args: { blocks: [...blocks, { name: 'stone', x: base.x + 10, y: base.y + 6, z: base.z + 10 }] } });
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    const bp = dry.result as { feasible: boolean; order: unknown[]; unsupported: unknown[]; missing: Record<string, number>; text: string };
    expect(bp.feasible).toBe(false);
    expect(bp.order).toHaveLength(6);
    expect(bp.unsupported).toHaveLength(1);
    expect(bp.missing).toEqual({});
    expect(bp.text).toMatch(/6 blocks to place/);
    const wall = await runtime!.runner.run({ action: 'build', args: { blocks } });
    expect(wall.ok, JSON.stringify(wall)).toBe(true);
    const r = wall.result as { placed: number; failureCount: number; alreadyCorrect: number };
    expect(r.placed + r.alreadyCorrect).toBeGreaterThanOrEqual(5);
    expect(r.failureCount).toBeLessThanOrEqual(1);
    // idempotent: a second build reports the cells as already correct
    const again = await runtime!.runner.run({ action: 'build', args: { blocks } });
    expect((again.result as { alreadyCorrect: number }).alreadyCorrect).toBeGreaterThanOrEqual(5);
    // materials check fails loudly when the inventory lacks the block
    const missing = await runtime!.runner.run({ action: 'build', args: { blocks: [{ name: 'diamond_block', x: base.x + 5, y: base.y, z: base.z + 5 }] } });
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe('MISSING_ITEM');
    // a floating block is reported, not walked to; strict mode refuses the whole structure
    const floating = await runtime!.runner.run({ action: 'build', args: { blocks: [{ name: 'stone', x: base.x + 5, y: base.y + 6, z: base.z + 5 }] } });
    expect(floating.ok).toBe(true);
    expect((floating.result as { failures: { error: string }[] }).failures[0]?.error).toMatch(/floating/);
    const refused = await runtime!.runner.run({ action: 'build', args: { blocks: [{ name: 'stone', x: base.x + 5, y: base.y + 6, z: base.z + 5 }], strict: true } });
    expect(refused.errorCode).toBe('BAD_REQUEST');
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

  it('builds a designed cottage (floor, log corners, walls, window panes) from a blueprint', async () => {
    const bot = runtime!.bot;
    const Item = createRequire(import.meta.url)('prismarine-item')(bot.registry) as new (id: number, count: number) => unknown;
    const cottage = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'cottage.json'), 'utf8')) as { blocks: { name: string; x: number; y: number; z: number }[] };
    // walls and windows only: the roof doubles the block count with the same primitives, and flying-squid mangles
    // doors and torches (it maps the door item to a wrong block and clears neighbouring cells) — those are for Paper.
    const base = bot.entity.position.floored();
    const origin = { x: base.x + 6, y: base.y, z: base.z + 6 };
    const blocks = cottage.blocks.filter((b) => b.y <= 3 && b.name !== 'oak_door' && b.name !== 'torch').map((b) => ({ ...b, x: b.x + origin.x, y: b.y + origin.y, z: b.z + origin.z }));
    const bom: Record<string, number> = {};
    for (const b of blocks) bom[b.name] = (bom[b.name] ?? 0) + 1;
    for (let slot = 36; slot <= 44; slot++) await bot.creative.setInventorySlot(slot, null as never);
    let slot = 36;
    for (const [name, count] of Object.entries(bom)) {
      for (let left = count; left > 0; left -= 64) await bot.creative.setInventorySlot(slot++, new Item(bot.registry.itemsByName[name]!.id, Math.min(64, left)) as never);
    }
    await new Promise((r) => setTimeout(r, 300));
    const dry = await runtime!.runner.run({ action: 'plan_build', args: { blocks } });
    const plan = dry.result as { feasible: boolean; order: unknown[]; missing: Record<string, number>; unsupported: unknown[] };
    expect(plan.feasible, JSON.stringify(dry).slice(0, 400)).toBe(true);
    expect(plan.order).toHaveLength(blocks.length);
    expect(plan.missing).toEqual({});
    const built = await runtime!.runner.run({ action: 'build', args: { blocks } });
    expect(built.ok, JSON.stringify(built).slice(0, 600)).toBe(true);
    const r = built.result as { placed: number; failureCount: number; failures: { block: { name: string }; error: string }[] };
    expect(r.placed, JSON.stringify(r.failures.slice(0, 5))).toBe(blocks.length);
    expect(r.failureCount).toBe(0);
    // the world agrees: log corners, planks and window panes stand exactly where the blueprint says
    const region = await runtime!.runner.run({ action: 'scan_region', args: { min: origin, max: { x: origin.x + 6, y: origin.y + 3, z: origin.z + 6 } } });
    const present = new Set(((region.result as { blocks: { x: number; y: number; z: number; name: string }[] }).blocks).map((b) => `${b.x},${b.y},${b.z}:${b.name}`));
    const missingCells = blocks.filter((b) => !present.has(`${b.x},${b.y},${b.z}:${b.name}`));
    expect(missingCells).toEqual([]);
    const counts = (region.result as { counts: Record<string, number> }).counts;
    expect(counts['oak_log']).toBe(bom['oak_log']);
    expect(counts['glass_pane']).toBe(bom['glass_pane']);
    // a second pass has nothing left to do
    const again = await runtime!.runner.run({ action: 'plan_build', args: { blocks } });
    expect((again.result as { alreadyCorrect: unknown[]; order: unknown[] }).alreadyCorrect).toHaveLength(blocks.length);
    expect((again.result as { order: unknown[] }).order).toHaveLength(0);
    // step off the site so the next tests stand on plain ground again
    const back = await runtime!.runner.run({ action: 'goto', args: { x: base.x - 3, y: base.y, z: base.z - 3, range: 1 } });
    expect(back.ok, JSON.stringify(back)).toBe(true);
  }, 400_000);

  it('plans procurement from the live inventory and surroundings (plan_get / get)', async () => {
    // flying-squid does not evaluate recipes server-side, so real crafting is covered by the Paper live
    // run; here we check the wiring: inventory → planner, nearby table detection, no-op and honest failure.
    const bot = runtime!.bot;
    const Item = createRequire(import.meta.url)('prismarine-item')(bot.registry) as new (id: number, count: number) => unknown;
    for (let slot = 36; slot <= 44; slot++) await bot.creative.setInventorySlot(slot, null as never);
    await bot.creative.setInventorySlot(36, new Item(bot.registry.itemsByName['oak_log']!.id, 8) as never);
    await bot.creative.setInventorySlot(37, new Item(bot.registry.itemsByName['crafting_table']!.id, 1) as never);
    await new Promise((r) => setTimeout(r, 300));
    expect(bot.inventory.items().map((i) => i.name).sort()).toEqual(['crafting_table', 'oak_log']);

    const dry = await runtime!.runner.run({ action: 'plan_get', args: { name: 'wooden_pickaxe' } });
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    const plan = dry.result as { feasible: boolean; steps: { kind: string; item: string; count: number }[]; text: string };
    expect(plan.feasible).toBe(true);
    expect(plan.steps.map((s) => `${s.kind}:${s.item}`)).toEqual(['place_table:crafting_table', 'craft:oak_planks', 'craft:stick', 'craft:wooden_pickaxe']);
    expect(plan.text).toContain('wooden_pickaxe');

    // once a table really stands next to us, the planner sees it and drops the placement step
    const base = bot.entity.position.floored();
    const spot = [[2, 2], [-2, 2], [2, -2], [-2, -2], [3, 0], [0, 3], [-3, 0], [0, -3]].map(([dx, dz]) => new Vec3(base.x + dx!, base.y, base.z + dz!)).find((p) => bot.blockAt(p)?.name === 'air' && bot.blockAt(p.offset(0, -1, 0))?.name !== 'air') ?? new Vec3(base.x + 2, base.y, base.z + 2);
    const placed = await runtime!.runner.run({ action: 'place', args: { name: 'crafting_table', x: spot.x, y: spot.y, z: spot.z } });
    expect(placed.ok, JSON.stringify(placed)).toBe(true);
    const withTable = await runtime!.runner.run({ action: 'plan_get', args: { name: 'wooden_pickaxe' } });
    expect((withTable.result as typeof plan).steps.map((s) => s.kind)).toEqual(['craft', 'craft', 'craft']);

    // already owned → nothing to do
    await bot.creative.setInventorySlot(38, new Item(bot.registry.itemsByName['wooden_pickaxe']!.id, 1) as never);
    await new Promise((r) => setTimeout(r, 300));
    const owned = await runtime!.runner.run({ action: 'get', args: { name: 'wooden_pickaxe' } });
    expect(owned.ok, JSON.stringify(owned)).toBe(true);
    expect(owned.result).toMatchObject({ done: true, have: 1, steps: 0, executed: [] });

    // honest failure: no spider on this empty superflat world, so string is out of reach
    const string = await runtime!.runner.run({ action: 'get', args: { name: 'string' } });
    expect(string.ok).toBe(false);
    expect(string.errorCode).toBe('MISSING_ITEM');
    expect(string.error).toMatch(/spider/);
    await runtime!.runner.run({ action: 'dig', args: { x: spot.x, y: spot.y, z: spot.z, collect: false } });
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
