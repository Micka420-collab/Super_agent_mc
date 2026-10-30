import { z } from 'zod';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { BodyError, ErrorCodes } from '../protocol.js';
import { approachEntity, followEntity, goTo, goToBlock, holdControl, stopAllMovement } from '../motor/movement.js';
import { sleep, throwIfAborted } from '../util/async.js';
import { distance, roundVec } from '../util/geometry.js';
import { defineAction, type ActionContext } from './registry.js';

export const EntitySelectorSchema = z.object({
  id: z.number().int().optional().describe('entity id from the observation'),
  username: z.string().optional().describe('player name'),
  name: z.string().optional().describe('entity type name, e.g. "zombie", "cow" — nearest match is used'),
});

export function resolveEntity(ctx: ActionContext, sel: z.infer<typeof EntitySelectorSchema>, maxDistance = 64): Entity {
  const bot = ctx.bot;
  if (sel.id !== undefined) {
    const e = bot.entities[sel.id];
    if (!e) throw new BodyError(ErrorCodes.NOT_FOUND, `no entity with id ${sel.id} in view`);
    return e;
  }
  if (sel.username) {
    const p = bot.players[sel.username]?.entity;
    if (!p) throw new BodyError(ErrorCodes.NOT_FOUND, `player ${sel.username} is not in render distance`);
    return p;
  }
  if (sel.name) {
    const n = sel.name.toLowerCase();
    const e = bot.nearestEntity((ent) => (ent.name === n || ent.username?.toLowerCase() === n) && distance(ent.position, bot.entity.position) <= maxDistance);
    if (!e) throw new BodyError(ErrorCodes.NOT_FOUND, `no ${sel.name} within ${maxDistance} blocks`);
    return e;
  }
  throw new BodyError(ErrorCodes.BAD_REQUEST, 'specify id, username or name');
}

defineAction({
  name: 'goto',
  category: 'movement',
  description: 'Walk to a position (pathfinding across terrain, digging/bridging when allowed). Resolves when within range.',
  longRunning: true,
  schema: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    range: z.number().min(0).max(32).default(1).describe('stop when this close'),
    timeoutMs: z.number().int().positive().max(600_000).default(90_000),
  }),
  async run(ctx, a) {
    await goTo(ctx.bot, a, a.range, ctx.signal, { timeoutMs: a.timeoutMs });
    return { position: roundVec(ctx.bot.entity.position), distance: Math.round(distance(ctx.bot.entity.position, a) * 10) / 10 };
  },
});

defineAction({
  name: 'goto_block',
  category: 'movement',
  description: 'Walk to stand adjacent to a block so you can interact with it.',
  longRunning: true,
  schema: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), timeoutMs: z.number().int().positive().default(90_000) }),
  async run(ctx, a) {
    await goToBlock(ctx.bot, a, ctx.signal, a.timeoutMs);
    return { position: roundVec(ctx.bot.entity.position) };
  },
});

defineAction({
  name: 'goto_entity',
  category: 'movement',
  description: 'Approach an entity (player or mob) until within range, re-planning as it moves.',
  longRunning: true,
  schema: EntitySelectorSchema.extend({
    range: z.number().min(1).max(16).default(2),
    timeoutMs: z.number().int().positive().default(60_000),
  }),
  async run(ctx, a) {
    const e = resolveEntity(ctx, a);
    await approachEntity(ctx.bot, e, a.range, ctx.signal, a.timeoutMs);
    return { target: ctx.observer.describeEntity(e) };
  },
});

defineAction({
  name: 'follow',
  category: 'movement',
  description: 'Keep following an entity (usually a player) until `stop` is called. Long running.',
  longRunning: true,
  schema: EntitySelectorSchema.extend({ range: z.number().min(1).max(16).default(3) }),
  async run(ctx, a) {
    const e = resolveEntity(ctx, a);
    ctx.progress(`following ${e.username ?? e.name}`);
    await followEntity(ctx.bot, e, a.range, ctx.signal);
    return { stopped: true };
  },
});

defineAction({
  name: 'stop',
  category: 'movement',
  description: 'Stop moving, fighting and digging immediately.',
  longRunning: false,
  schema: z.object({}),
  async run(ctx) {
    stopAllMovement(ctx.bot);
    const pvp = (ctx.bot as unknown as { pvp?: { stop: () => Promise<void> } }).pvp;
    if (pvp) await pvp.stop();
    ctx.bot.stopDigging();
    return { stopped: true };
  },
});

defineAction({
  name: 'look_at',
  category: 'movement',
  description: 'Turn the head to look at a point.',
  longRunning: false,
  schema: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  async run(ctx, a) {
    await ctx.bot.lookAt(new Vec3(a.x, a.y, a.z), true);
    return { yaw: ctx.bot.entity.yaw, pitch: ctx.bot.entity.pitch };
  },
});

defineAction({
  name: 'look',
  category: 'movement',
  description: 'Set head orientation directly. yaw: 0 = north, π/2 = west; pitch: positive = up (radians).',
  longRunning: false,
  schema: z.object({ yaw: z.number(), pitch: z.number().min(-Math.PI / 2).max(Math.PI / 2) }),
  async run(ctx, a) {
    await ctx.bot.look(a.yaw, a.pitch, true);
    return { yaw: ctx.bot.entity.yaw, pitch: ctx.bot.entity.pitch };
  },
});

defineAction({
  name: 'move',
  category: 'movement',
  description: 'Fine motor control: hold a movement key for a duration (ms). Use for nudges, dodges, jumps.',
  longRunning: false,
  schema: z.object({
    control: z.enum(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']),
    ms: z.number().int().min(10).max(10_000).default(300),
  }),
  async run(ctx, a) {
    await holdControl(ctx.bot, a.control, a.ms, ctx.signal);
    return { position: roundVec(ctx.bot.entity.position) };
  },
});

defineAction({
  name: 'jump',
  category: 'movement',
  description: 'Jump once.',
  longRunning: false,
  schema: z.object({}),
  async run(ctx) {
    await holdControl(ctx.bot, 'jump', 120, ctx.signal);
    return { onGround: ctx.bot.entity.onGround };
  },
});

defineAction({
  name: 'sneak',
  category: 'movement',
  description: 'Toggle sneaking (prevents falling off edges, hides nametag).',
  longRunning: false,
  schema: z.object({ on: z.boolean() }),
  async run(ctx, a) {
    ctx.bot.setControlState('sneak', a.on);
    return { sneaking: a.on };
  },
});

defineAction({
  name: 'explore',
  category: 'movement',
  description:
    'Explore in a direction (or random) for a while, stopping early when a wanted block/entity comes into view. Returns what was found.',
  longRunning: true,
  schema: z.object({
    direction: z.enum(['north', 'south', 'east', 'west', 'random']).default('random'),
    maxSeconds: z.number().int().min(5).max(300).default(45),
    lookFor: z.array(z.string()).default([]).describe('block or entity names that end exploration when seen'),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const dirs: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
    let [dx, dz] = a.direction === 'random' ? [Math.random() * 2 - 1, Math.random() * 2 - 1] : (dirs[a.direction] as [number, number]);
    const norm = Math.hypot(dx, dz) || 1;
    dx /= norm;
    dz /= norm;
    const deadline = Date.now() + a.maxSeconds * 1000;
    const wanted = new Set(a.lookFor.map((s) => s.toLowerCase()));
    const start = roundVec(bot.entity.position);
    let found: unknown = null;
    while (Date.now() < deadline && !found) {
      throwIfAborted(ctx.signal);
      const step = 12 + Math.random() * 12;
      const target = { x: bot.entity.position.x + dx * step, y: bot.entity.position.y, z: bot.entity.position.z + dz * step };
      try {
        await goTo(bot, target, 4, ctx.signal, { timeoutMs: 20_000 });
      } catch (err) {
        if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
        // obstacle: rotate direction a bit and keep going
        const ang = Math.atan2(dz, dx) + (Math.random() - 0.5) * Math.PI;
        dx = Math.cos(ang);
        dz = Math.sin(ang);
      }
      if (wanted.size) {
        const blockHits = bot.findBlocks({ matching: (b) => wanted.has(b.name), maxDistance: 32, count: 5 });
        const first = blockHits[0];
        if (first) {
          found = { kind: 'block', name: bot.blockAt(first)?.name, position: { x: first.x, y: first.y, z: first.z } };
          break;
        }
        const ent = bot.nearestEntity((e) => wanted.has(e.name ?? '') || wanted.has(e.username?.toLowerCase() ?? ''));
        if (ent) {
          found = { kind: 'entity', entity: ctx.observer.describeEntity(ent) };
          break;
        }
      }
      ctx.progress('exploring', { position: roundVec(bot.entity.position) });
      await sleep(50, ctx.signal);
    }
    return { found, from: start, to: roundVec(bot.entity.position), travelled: Math.round(distance(start, bot.entity.position)) };
  },
});
