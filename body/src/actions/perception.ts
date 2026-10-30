import { z } from 'zod';
import { Vec3 } from 'vec3';
import { BodyError, ErrorCodes } from '../protocol.js';
import { resolveBlockNames } from '../motor/items.js';
import { sleep } from '../util/async.js';
import { distance, round } from '../util/geometry.js';
import { defineAction } from './registry.js';

defineAction({
  name: 'observe',
  category: 'perception',
  description: 'Return a fresh observation (what I see, feel, carry).',
  longRunning: false,
  schema: z.object({ detail: z.enum(['compact', 'full']).default('compact') }),
  async run(ctx, a) {
    return ctx.observer.observe(a.detail);
  },
});

defineAction({
  name: 'find_blocks',
  category: 'perception',
  description: 'Find blocks by name(s) around me (fuzzy names allowed). Returns positions sorted by distance.',
  longRunning: false,
  schema: z.object({
    names: z.array(z.string()).min(1),
    maxDistance: z.number().min(1).max(256).default(48),
    count: z.number().int().min(1).max(500).default(16),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const resolved = new Set(a.names.flatMap((n) => resolveBlockNames(bot, n)));
    if (!resolved.size) throw new BodyError(ErrorCodes.NOT_FOUND, `unknown block names: ${a.names.join(', ')}`);
    const positions = bot.findBlocks({ matching: (b) => resolved.has(b.name), maxDistance: a.maxDistance, count: a.count });
    const me = bot.entity.position;
    const blocks = positions
      .map((p) => ({ name: bot.blockAt(p)?.name ?? 'unknown', position: { x: p.x, y: p.y, z: p.z }, distance: round(distance(me, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 })) }))
      .sort((x, y) => x.distance - y.distance);
    return { matched: [...resolved], blocks };
  },
});

defineAction({
  name: 'block_at',
  category: 'perception',
  description: 'Describe the block at coordinates (name, light, hardness, whether I can see/dig it).',
  longRunning: false,
  schema: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const b = bot.blockAt(new Vec3(a.x, a.y, a.z));
    if (!b) throw new BodyError(ErrorCodes.NOT_FOUND, 'chunk not loaded');
    return {
      name: b.name,
      displayName: b.displayName,
      position: a,
      light: b.light,
      skyLight: b.skyLight,
      hardness: b.hardness,
      diggable: b.diggable,
      canSee: bot.canSeeBlock(b),
      canDig: bot.canDigBlock(b),
      properties: typeof (b as unknown as { getProperties?: () => unknown }).getProperties === 'function' ? (b as unknown as { getProperties: () => unknown }).getProperties() : undefined,
      biome: b.biome?.name,
    };
  },
});

defineAction({
  name: 'scan_region',
  category: 'perception',
  description: 'Return every non-air block in a box (for a site survey or to copy a structure). Bounded to 50k blocks.',
  longRunning: false,
  schema: z.object({
    min: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    max: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
    skipAir: z.boolean().default(true),
    maxBlocks: z.number().int().min(1).max(50_000).default(20_000),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const lo = { x: Math.min(a.min.x, a.max.x), y: Math.min(a.min.y, a.max.y), z: Math.min(a.min.z, a.max.z) };
    const hi = { x: Math.max(a.min.x, a.max.x), y: Math.max(a.min.y, a.max.y), z: Math.max(a.min.z, a.max.z) };
    const volume = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1);
    if (volume > a.maxBlocks) throw new BodyError(ErrorCodes.BAD_REQUEST, `region has ${volume} blocks, max ${a.maxBlocks}`);
    const blocks: { x: number; y: number; z: number; name: string }[] = [];
    const counts: Record<string, number> = {};
    let unloaded = 0;
    for (let y = lo.y; y <= hi.y; y++) for (let x = lo.x; x <= hi.x; x++) for (let z = lo.z; z <= hi.z; z++) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b) {
        unloaded += 1;
        continue;
      }
      counts[b.name] = (counts[b.name] ?? 0) + 1;
      if (a.skipAir && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')) continue;
      blocks.push({ x, y, z, name: b.name });
    }
    return { min: lo, max: hi, volume, unloaded, counts, blocks };
  },
});

defineAction({
  name: 'surface_height',
  category: 'perception',
  description: 'Heightmap of the terrain around a point (highest solid block per column) — for choosing a build site.',
  longRunning: false,
  schema: z.object({ x: z.number().int(), z: z.number().int(), radius: z.number().int().min(1).max(16).default(6) }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const yStart = Math.floor(bot.entity.position.y) + 12;
    const heights: number[][] = [];
    const top: Record<string, number> = {};
    for (let dz = -a.radius; dz <= a.radius; dz++) {
      const row: number[] = [];
      for (let dx = -a.radius; dx <= a.radius; dx++) {
        let h = -64;
        for (let y = yStart; y >= Math.max(-64, yStart - 40); y--) {
          const b = bot.blockAt(new Vec3(a.x + dx, y, a.z + dz));
          if (b && b.boundingBox === 'block') {
            h = y;
            top[b.name] = (top[b.name] ?? 0) + 1;
            break;
          }
        }
        row.push(h);
      }
      heights.push(row);
    }
    const flat = heights.flat().filter((h) => h > -64);
    const min = Math.min(...flat);
    const max = Math.max(...flat);
    return { center: { x: a.x, z: a.z }, radius: a.radius, heights, min, max, roughness: max - min, surfaceBlocks: top };
  },
});

defineAction({
  name: 'wait',
  category: 'meta',
  description: 'Do nothing for a while (watch, let something finish, let the night pass in a shelter).',
  longRunning: true,
  schema: z.object({ ms: z.number().int().min(50).max(300_000).default(1000), reason: z.string().optional() }),
  async run(ctx, a) {
    await sleep(a.ms, ctx.signal);
    return { waited: a.ms, reason: a.reason };
  },
});

defineAction({
  name: 'players',
  category: 'perception',
  description: 'List online players with distance when they are in render range.',
  longRunning: false,
  schema: z.object({}),
  async run(ctx) {
    const bot = ctx.bot;
    return {
      players: Object.values(bot.players)
        .filter((p) => p.username !== bot.username)
        .map((p) => ({
          username: p.username,
          ping: p.ping,
          gamemode: p.gamemode,
          visible: !!p.entity,
          distance: p.entity ? round(distance(bot.entity.position, p.entity.position)) : undefined,
          position: p.entity ? { x: round(p.entity.position.x), y: round(p.entity.position.y), z: round(p.entity.position.z) } : undefined,
        })),
    };
  },
});
