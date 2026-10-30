/**
 * Bridge server — the WebSocket endpoint the mind connects to.
 *
 * One body, possibly several observers (a mind plus a dashboard), but only one connection may
 * command the body at a time: the first authenticated client becomes the "driver"; others are
 * read-only until the driver disconnects.
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { ActionRunner } from '../actions/runner.js';
import { buildManifest, buildSkillApiDoc, listActions } from '../actions/registry.js';
import type { Observer } from '../perception/observer.js';
import type { ReflexSystem } from '../motor/reflexes.js';
import type { VisionProvider } from '../vision/index.js';
import { runSkill, checkSkill } from '../skills/sandbox.js';
import {
  ActionRequestSchema,
  BodyError,
  ErrorCodes,
  EnvelopeSchema,
  FindRequestSchema,
  PROTOCOL_VERSION,
  ReflexConfigSchema,
  RegionRequestSchema,
  RenderRequestSchema,
  RequestEnvelopeSchema,
  SkillRunRequestSchema,
  StreamConfigSchema,
  type EventName,
  type HelloResult,
  type ResponseEnvelope,
} from '../protocol.js';
import { getLogger } from '../util/logger.js';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { resolveBlockNames } from '../motor/items.js';
import { distance, round } from '../util/geometry.js';
import { z } from 'zod';

export interface BridgeRuntime {
  bot: Bot;
  observer: Observer;
  runner: ActionRunner;
  reflexes: ReflexSystem;
  vision: VisionProvider;
}

export interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  observationHz: number;
  mcHost: string;
  mcPort: number;
}

export interface BridgeDeps extends BridgeRuntime {
  config: BridgeConfig;
  bodyVersion: string;
}

interface Client {
  ws: WebSocket;
  driver: boolean;
  stream: { observationHz: number; detail: 'compact' | 'full' };
  timer?: NodeJS.Timeout;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<Client>();
  private readonly log = getLogger('bridge');

  private deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  /** Swap the live runtime (after a reconnect) while keeping client connections. */
  setRuntime(rt: BridgeRuntime): void {
    this.deps = { ...this.deps, ...rt };
  }

  start(): void {
    const { host, port } = this.deps.config;
    this.wss = new WebSocketServer({ host, port });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('listening', () => this.log.info({ host, port }, 'bridge listening'));
    this.wss.on('error', (err) => this.log.error({ err }, 'bridge server error'));
  }

  stop(): void {
    for (const c of this.clients) {
      if (c.timer) clearInterval(c.timer);
      c.ws.close();
    }
    this.clients.clear();
    this.wss?.close();
  }

  /** Broadcast an event to every connected client. */
  emit(event: EventName, payload: unknown): void {
    const frame = JSON.stringify({ kind: 'event', event, ts: Date.now(), payload });
    for (const c of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(frame);
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.deps.config.token;
    if (!token) return true;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const q = url.searchParams.get('token');
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    return q === token || bearer === token;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    if (!this.authorized(req)) {
      this.log.warn({ ip: req.socket.remoteAddress }, 'rejected unauthenticated connection');
      ws.close(4401, 'unauthorized');
      return;
    }
    const hasDriver = [...this.clients].some((c) => c.driver);
    const client: Client = { ws, driver: !hasDriver, stream: { observationHz: this.deps.config.observationHz, detail: 'compact' } };
    this.clients.add(client);
    this.log.info({ driver: client.driver, clients: this.clients.size }, 'client connected');
    this.setupStream(client);

    ws.on('message', (data) => void this.onMessage(client, data));
    ws.on('close', () => {
      if (client.timer) clearInterval(client.timer);
      this.clients.delete(client);
      this.log.info({ clients: this.clients.size }, 'client disconnected');
      if (client.driver) {
        // promote the oldest remaining client
        const next = [...this.clients][0];
        if (next) next.driver = true;
      }
    });
    ws.on('error', (err) => this.log.warn({ err }, 'client socket error'));

    ws.send(JSON.stringify({ kind: 'event', event: 'ready', ts: Date.now(), payload: { driver: client.driver, protocol: PROTOCOL_VERSION } }));
  }

  private setupStream(client: Client): void {
    if (client.timer) clearInterval(client.timer);
    const hz = client.stream.observationHz;
    if (hz <= 0) return;
    client.timer = setInterval(() => {
      if (client.ws.readyState !== WebSocket.OPEN || !this.deps.bot.entity) return;
      if (client.ws.bufferedAmount > 512 * 1024) return; // backpressure: skip a frame
      try {
        const obs = this.deps.observer.observe(client.stream.detail);
        client.ws.send(JSON.stringify({ kind: 'event', event: 'observation', ts: Date.now(), payload: obs }));
      } catch (err) {
        this.log.warn({ err }, 'observation stream failed');
      }
    }, Math.round(1000 / hz));
  }

  private send(client: Client, response: ResponseEnvelope): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(response));
  }

  private async onMessage(client: Client, data: RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.send(client, { kind: 'response', id: 'unknown', ok: false, error: { code: ErrorCodes.BAD_REQUEST, message: 'invalid JSON' } });
      return;
    }
    const env = EnvelopeSchema.safeParse(parsed);
    if (!env.success || env.data.kind !== 'request') {
      const id = (parsed as { id?: string })?.id ?? 'unknown';
      this.send(client, { kind: 'response', id, ok: false, error: { code: ErrorCodes.BAD_REQUEST, message: 'expected a request envelope', data: env.success ? undefined : env.error.issues } });
      return;
    }
    const req = RequestEnvelopeSchema.parse(env.data);
    try {
      const result = await this.dispatch(client, req.method, req.params);
      this.send(client, { kind: 'response', id: req.id, ok: true, result });
    } catch (err) {
      const e = err instanceof BodyError ? err : new BodyError(ErrorCodes.INTERNAL, (err as Error)?.message ?? String(err));
      if (!(err instanceof BodyError)) this.log.error({ err, method: req.method }, 'request failed');
      this.send(client, { kind: 'response', id: req.id, ok: false, error: { code: e.code, message: e.message, data: e.data } });
    }
  }

  private requireDriver(client: Client): void {
    if (!client.driver) throw new BodyError(ErrorCodes.BUSY, 'this connection is read-only (another mind is driving)');
  }

  private requireBot(): Bot {
    const bot = this.deps.bot;
    if (!bot.entity) throw new BodyError(ErrorCodes.NOT_CONNECTED, 'not spawned in the world yet');
    return bot;
  }

  private async dispatch(client: Client, method: string, params: unknown): Promise<unknown> {
    const { observer, runner, reflexes, vision } = this.deps;
    switch (method) {
      case 'hello': {
        const bot = this.deps.bot;
        const hello: HelloResult = {
          protocol: PROTOCOL_VERSION,
          body: { name: '@emeth/body', version: this.deps.bodyVersion },
          minecraft: { version: bot.version, host: this.deps.config.mcHost, port: this.deps.config.mcPort, username: bot.username },
          capabilities: { vision: vision.mode, skills: true, reflexes: true },
          actions: buildManifest(),
          skillApiDoc: buildSkillApiDoc(),
        };
        return hello;
      }
      case 'actions.manifest':
        return { actions: buildManifest(), count: listActions().length };
      case 'observe': {
        this.requireBot();
        const p = z.object({ detail: z.enum(['compact', 'full']).default('compact') }).parse(params ?? {});
        return observer.observe(p.detail);
      }
      case 'act': {
        this.requireDriver(client);
        this.requireBot();
        const a = ActionRequestSchema.parse(params);
        return runner.run(a);
      }
      case 'skill.run': {
        this.requireDriver(client);
        this.requireBot();
        const s = SkillRunRequestSchema.parse(params);
        return runSkill(s, runner);
      }
      case 'skill.check': {
        const p = z.object({ code: z.string() }).parse(params);
        return checkSkill(p.code);
      }
      case 'chat': {
        this.requireDriver(client);
        const bot = this.requireBot();
        const p = z.object({ text: z.string().min(1).max(2000), to: z.string().optional() }).parse(params);
        const { splitChat, sanitizeChat } = await import('../actions/social.js');
        const parts = splitChat(sanitizeChat(p.text));
        for (const part of parts) {
          if (p.to) bot.whisper(p.to, part);
          else bot.chat(part);
          observer.pushChat({ ts: Date.now(), from: p.to ? `${bot.username}→${p.to}` : bot.username, text: part, type: p.to ? 'whisper' : 'chat' });
        }
        return { sent: parts.length };
      }
      case 'stop': {
        this.requireDriver(client);
        return runner.run({ action: 'stop', args: {} });
      }
      case 'reflex.configure': {
        this.requireDriver(client);
        const partial = ReflexConfigSchema.partial().parse(params ?? {});
        return reflexes.configure(partial);
      }
      case 'stream.configure': {
        const s = StreamConfigSchema.parse(params ?? {});
        client.stream = { observationHz: s.observationHz, detail: s.detail };
        this.setupStream(client);
        return client.stream;
      }
      case 'vision.render': {
        this.requireBot();
        const r = RenderRequestSchema.parse(params ?? {});
        return vision.render(r);
      }
      case 'world.region': {
        const bot = this.requireBot();
        const r = RegionRequestSchema.parse(params);
        const lo = { x: Math.min(r.min.x, r.max.x), y: Math.min(r.min.y, r.max.y), z: Math.min(r.min.z, r.max.z) };
        const hi = { x: Math.max(r.min.x, r.max.x), y: Math.max(r.min.y, r.max.y), z: Math.max(r.min.z, r.max.z) };
        const volume = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1);
        if (volume > r.maxBlocks) throw new BodyError(ErrorCodes.BAD_REQUEST, `region has ${volume} blocks, max ${r.maxBlocks}`);
        const blocks: { x: number; y: number; z: number; name: string }[] = [];
        for (let y = lo.y; y <= hi.y; y++) for (let x = lo.x; x <= hi.x; x++) for (let z = lo.z; z <= hi.z; z++) {
          const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
          if (!b) continue;
          if (r.skipAir && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')) continue;
          blocks.push({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), name: b.name });
        }
        return { min: lo, max: hi, blocks };
      }
      case 'world.find': {
        const bot = this.requireBot();
        const f = FindRequestSchema.parse(params);
        const names = new Set(f.names.flatMap((n) => resolveBlockNames(bot, n)));
        const me = bot.entity.position;
        const positions = bot.findBlocks({ matching: (b) => names.has(b.name), maxDistance: f.maxDistance, count: f.count });
        return {
          blocks: positions
            .map((p) => ({ name: bot.blockAt(p)?.name ?? 'unknown', position: { x: p.x, y: p.y, z: p.z }, distance: round(distance(me, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 })) }))
            .sort((a, b) => a.distance - b.distance),
        };
      }
      default:
        throw new BodyError(ErrorCodes.UNKNOWN_METHOD, `unknown method ${method}`);
    }
  }
}
