/**
 * Observer — assembles the Observation the mind reasons about.
 *
 * Two perception modes:
 *   - omniscient (default): entities & notable blocks within MC_PERCEPTION_RADIUS, like most bots.
 *   - honest (MC_HONEST_PERCEPTION=1): entities must be in line of sight, blocks come from the FOV scan.
 * Both modes always include the FOV scan ("vision") so the mind knows what is *in front* of it.
 */
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Block } from 'prismarine-block';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import type {
  BlockView,
  ChatLine,
  EntityView,
  ItemStack,
  Observation,
  Vec3Like,
} from '../protocol.js';
import { bearingTo, distance, relativeDirection, round, roundVec } from '../util/geometry.js';
import { classifyEntity } from './entities.js';
import { scanFov, type FovScanOptions, type FovScanResult, type RayHit, type Raycaster } from './fov.js';

export interface ObserverOptions {
  honestPerception: boolean;
  perceptionRadius: number;
  fovDeg: number;
  chatBufferSize: number;
  eventBufferSize: number;
}

export const DEFAULT_OBSERVER_OPTIONS: ObserverOptions = {
  honestPerception: false,
  perceptionRadius: 32,
  fovDeg: 110,
  chatBufferSize: 20,
  eventBufferSize: 30,
};

/** Blocks worth pointing out explicitly to the mind (positions, not just counts). */
export const NOTABLE_BLOCK_PREDICATE = (name: string): boolean =>
  name.endsWith('_ore') ||
  name === 'ancient_debris' ||
  name === 'crafting_table' ||
  name === 'furnace' ||
  name === 'blast_furnace' ||
  name === 'smoker' ||
  name === 'chest' ||
  name === 'trapped_chest' ||
  name === 'barrel' ||
  name === 'ender_chest' ||
  name === 'shulker_box' ||
  name.endsWith('_bed') ||
  name === 'water' ||
  name === 'lava' ||
  name === 'spawner' ||
  name === 'trial_spawner' ||
  name === 'nether_portal' ||
  name === 'end_portal_frame' ||
  name === 'enchanting_table' ||
  name === 'anvil' ||
  name === 'bell' ||
  name === 'beehive' ||
  name === 'bee_nest' ||
  name.endsWith('_sign') ||
  name === 'lectern' ||
  name === 'bookshelf' ||
  name === 'obsidian' ||
  name === 'crying_obsidian' ||
  name === 'torch' ||
  name === 'wall_torch' ||
  name === 'campfire' ||
  name === 'lantern' ||
  name === 'cake' ||
  name === 'wheat' ||
  name === 'carrots' ||
  name === 'potatoes' ||
  name === 'beetroots' ||
  name === 'melon' ||
  name === 'pumpkin' ||
  name === 'sugar_cane' ||
  name === 'bamboo';

interface RecentEvent {
  ts: number;
  event: string;
  summary: string;
}

export class Observer {
  private readonly chat: ChatLine[] = [];
  private readonly events: RecentEvent[] = [];
  private tick = 0;
  private lastScan: FovScanResult | null = null;
  private currentActionGetter: () => Observation['action'] = () => null;

  constructor(
    private readonly bot: Bot,
    private readonly opts: ObserverOptions = DEFAULT_OBSERVER_OPTIONS,
  ) {}

  /** Wire up buffers from bot events. Called once by index.ts. */
  attach(): void {
    this.bot.on('physicsTick', () => {
      this.tick += 1;
    });
    this.bot.on('chat', (username, message) => {
      if (username === this.bot.username) return;
      this.pushChat({ ts: Date.now(), from: username, text: message, type: 'chat' });
    });
    this.bot.on('whisper', (username, message) => {
      this.pushChat({ ts: Date.now(), from: username, text: message, type: 'whisper' });
    });
  }

  setCurrentActionGetter(fn: () => Observation['action']): void {
    this.currentActionGetter = fn;
  }

  pushChat(line: ChatLine): void {
    this.chat.push(line);
    while (this.chat.length > this.opts.chatBufferSize) this.chat.shift();
  }

  pushEvent(event: string, summary: string, ts = Date.now()): void {
    this.events.push({ ts, event, summary });
    while (this.events.length > this.opts.eventBufferSize) this.events.shift();
  }

  /** The last FOV scan — reused by the retina so image & text are consistent. */
  getLastScan(): FovScanResult | null {
    return this.lastScan;
  }

  // -------------------------------------------------------------------------------------------
  // Raycasting against the live world
  // -------------------------------------------------------------------------------------------
  readonly raycast: Raycaster = (from, direction, maxDistance) => {
    const world = this.bot.world as unknown as {
      raycast: (f: Vec3, d: Vec3, r: number) => (Block & { intersect?: Vec3 }) | null;
    };
    const hit = world.raycast(new Vec3(from.x, from.y, from.z), new Vec3(direction.x, direction.y, direction.z), maxDistance);
    if (!hit || !hit.position) return null;
    const out: RayHit = { name: hit.name, position: { x: hit.position.x, y: hit.position.y, z: hit.position.z } };
    if (hit.intersect) out.intersect = { x: hit.intersect.x, y: hit.intersect.y, z: hit.intersect.z };
    if (typeof hit.light === 'number') out.light = hit.light;
    return out;
  };

  eyePosition(): Vec3Like {
    const p = this.bot.entity.position;
    const h = (this.bot.entity as unknown as { height?: number }).height ?? 1.62;
    return { x: p.x, y: p.y + h, z: p.z };
  }

  /** Line-of-sight test to a point (used for entities). */
  canSee(target: Vec3Like): boolean {
    const eye = this.eyePosition();
    const d = distance(eye, target);
    if (d < 1.5) return true;
    const dir = { x: (target.x - eye.x) / d, y: (target.y - eye.y) / d, z: (target.z - eye.z) / d };
    const hit = this.raycast(eye, dir, d);
    if (!hit) return true;
    const hitPoint = hit.intersect ?? { x: hit.position.x + 0.5, y: hit.position.y + 0.5, z: hit.position.z + 0.5 };
    return distance(eye, hitPoint) >= d - 0.75;
  }

  // -------------------------------------------------------------------------------------------
  // Observation assembly
  // -------------------------------------------------------------------------------------------
  observe(detail: 'compact' | 'full' = 'compact'): Observation {
    const bot = this.bot;
    const eye = this.eyePosition();

    const scanOpts: FovScanOptions = detail === 'full'
      ? { fovDeg: this.opts.fovDeg, cols: 48, rows: 27, maxDistance: 64 }
      : { fovDeg: this.opts.fovDeg, cols: 32, rows: 18, maxDistance: 48 };
    const scan = scanFov(eye, bot.entity.yaw, bot.entity.pitch, this.raycast, scanOpts);
    this.lastScan = scan;

    const observation: Observation = {
      ts: Date.now(),
      tick: this.tick,
      detail,
      self: this.selfState(),
      world: this.worldState(),
      inventory: this.inventoryState(),
      entities: this.entitiesState(detail),
      blocks: this.blocksState(scan, detail),
      vision: {
        visible: scan.visible.slice(0, detail === 'full' ? 400 : 80),
        horizon: scan.horizon,
        fovDeg: scanOpts.fovDeg,
        rays: scanOpts.cols * scanOpts.rows,
      },
      chat: [...this.chat],
      events: [...this.events],
      action: this.currentActionGetter(),
    };
    return observation;
  }

  private selfState(): Observation['self'] {
    const bot = this.bot;
    const e = bot.entity;
    const feet = bot.blockAt(e.position);
    const effects: Observation['self']['effects'] = [];
    const rawEffects = (e as unknown as { effects?: Record<string, { id: number; amplifier: number; duration: number }> }).effects ?? {};
    for (const eff of Object.values(rawEffects)) {
      const def = bot.registry.effects?.[eff.id];
      effects.push({ name: def?.name ?? `effect_${eff.id}`, amplifier: eff.amplifier, durationTicks: eff.duration });
    }
    const slot = (name: 'head' | 'torso' | 'legs' | 'feet'): string | null => {
      const idx = bot.getEquipmentDestSlot(name);
      const item = bot.inventory.slots[idx];
      return item ? item.name : null;
    };
    const dimension = (bot.game as unknown as { dimension?: string }).dimension ?? 'overworld';
    return {
      username: bot.username,
      position: roundVec(e.position, 2),
      yaw: round(e.yaw, 3),
      pitch: round(e.pitch, 3),
      health: round(num(bot.health, 20), 1),
      food: num(bot.food, 20),
      saturation: round(num(bot.foodSaturation, 5), 1),
      oxygen: num(bot.oxygenLevel, 20),
      xpLevel: num(bot.experience?.level, 0),
      xpProgress: round(num(bot.experience?.progress, 0), 2),
      gameMode: String(bot.game.gameMode),
      dimension: dimension.replace('minecraft:', ''),
      onGround: e.onGround,
      isSleeping: bot.isSleeping,
      isInWater: (e as unknown as { isInWater?: boolean }).isInWater ?? feet?.name === 'water',
      isInLava: (e as unknown as { isInLava?: boolean }).isInLava ?? feet?.name === 'lava',
      isOnFire: (e as unknown as { onFire?: boolean }).onFire ?? false,
      velocity: roundVec(e.velocity, 2),
      heldItem: toItemStack(bot.heldItem),
      offhandItem: toItemStack(bot.inventory.slots[45] ?? null),
      armor: { head: slot('head'), torso: slot('torso'), legs: slot('legs'), feet: slot('feet') },
      effects,
      biome: feet?.biome?.name ?? 'unknown',
    };
  }

  private worldState(): Observation['world'] {
    const bot = this.bot;
    const t = bot.time.timeOfDay;
    let phase: Observation['world']['phase'];
    if (t >= 23000 || t < 1000) phase = 'dawn';
    else if (t < 12000) phase = 'day';
    else if (t < 13000) phase = 'dusk';
    else phase = 'night';
    const feet = bot.blockAt(bot.entity.position);
    return {
      timeOfDay: t,
      day: bot.time.day,
      phase,
      isRaining: bot.isRaining,
      isThundering: bot.thunderState > 0,
      lightLevel: feet?.light ?? 0,
      skyLight: feet?.skyLight ?? 0,
      moonPhase: (bot.time as unknown as { moonPhase?: number }).moonPhase,
    };
  }

  private inventoryState(): Observation['inventory'] {
    const bot = this.bot;
    const items = bot.inventory.items().map((i) => toItemStack(i) as ItemStack);
    const hotbar: (ItemStack | null)[] = [];
    for (let i = 0; i < 9; i++) hotbar.push(toItemStack(bot.inventory.slots[36 + i] ?? null));
    const totalSlots = 36;
    const used = bot.inventory.items().filter((i) => i.slot >= 9 && i.slot < 45).length;
    return { items, freeSlots: Math.max(0, totalSlots - used), totalSlots, hotbar, selectedHotbarSlot: bot.quickBarSlot };
  }

  private entitiesState(detail: 'compact' | 'full'): Observation['entities'] {
    const bot = this.bot;
    const me = bot.entity;
    const out: Observation['entities'] = { players: [], hostiles: [], passives: [], items: [], other: [] };
    const radius = this.opts.perceptionRadius;
    const maxPer = detail === 'full' ? 40 : 12;

    const views: EntityView[] = [];
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === me || !entity.position) continue;
      const d = distance(me.position, entity.position);
      if (d > radius) continue;
      const view = this.describeEntity(entity, d);
      if (this.opts.honestPerception && !view.visible) continue;
      views.push(view);
    }
    views.sort((a, b) => a.distance - b.distance);
    for (const v of views) {
      const bucket =
        v.kind === 'player' ? out.players
          : v.kind === 'hostile' ? out.hostiles
            : v.kind === 'passive' || v.kind === 'neutral' ? out.passives
              : v.kind === 'item' ? out.items
                : out.other;
      if (bucket.length < maxPer) bucket.push(v);
    }
    return out;
  }

  describeEntity(entity: Entity, d?: number): EntityView {
    const bot = this.bot;
    const me = bot.entity;
    const dist = d ?? distance(me.position, entity.position);
    const name = entity.name ?? entity.type ?? 'unknown';
    const def = bot.registry.entitiesByName?.[name];
    const kind = classifyEntity({ type: entity.type, name, category: def?.category });
    const target = { x: entity.position.x, y: entity.position.y + ((entity as unknown as { height?: number }).height ?? 1) * 0.8, z: entity.position.z };
    const view: EntityView = {
      id: entity.id,
      name,
      kind,
      position: roundVec(entity.position, 1),
      distance: round(dist),
      bearing: bearingTo(me.position, entity.position),
      relative: relativeDirection(me.position, me.yaw, entity.position),
      visible: this.canSee(target),
    };
    if (entity.type === 'player' && entity.username) view.username = entity.username;
    if (typeof entity.health === 'number') view.health = round(entity.health);
    const held = entity.heldItem;
    if (held) view.heldItem = held.name;
    if (kind === 'item') {
      const dropped = droppedItemOf(entity);
      if (dropped) {
        view.itemName = dropped.name;
        view.itemCount = dropped.count;
      }
    }
    if (entity.velocity && (Math.abs(entity.velocity.x) > 0.05 || Math.abs(entity.velocity.z) > 0.05 || Math.abs(entity.velocity.y) > 0.05)) {
      view.velocity = roundVec(entity.velocity, 2);
    }
    return view;
  }

  private blocksState(scan: FovScanResult, detail: 'compact' | 'full'): Observation['blocks'] {
    const bot = this.bot;
    const pos = bot.entity.position;
    const below = bot.blockAt(pos.offset(0, -1, 0));
    const feet = bot.blockAt(pos);
    const head = bot.blockAt(pos.offset(0, 1, 0));
    const facingBlock = bot.blockAtCursor(6);
    const facing: BlockView | null = facingBlock
      ? {
        name: facingBlock.name,
        position: { x: facingBlock.position.x, y: facingBlock.position.y, z: facingBlock.position.z },
        distance: round(distance(this.eyePosition(), { x: facingBlock.position.x + 0.5, y: facingBlock.position.y + 0.5, z: facingBlock.position.z + 0.5 })),
      }
      : null;

    // Notable blocks: either from honest FOV scan or from a radius search.
    let notable: BlockView[];
    if (this.opts.honestPerception) {
      notable = scan.visible.filter((b) => NOTABLE_BLOCK_PREDICATE(b.name)).slice(0, detail === 'full' ? 60 : 20);
    } else {
      notable = this.findNotable(detail === 'full' ? 60 : 24);
    }

    const nearbyCounts = this.countNearby(detail === 'full' ? 8 : 5);

    return {
      standingOn: below?.name ?? 'unknown',
      atFeet: feet?.name ?? 'unknown',
      atHead: head?.name ?? 'unknown',
      facing,
      notable,
      nearbyCounts,
    };
  }

  private findNotable(limit: number): BlockView[] {
    const bot = this.bot;
    const me = bot.entity.position;
    const positions = bot.findBlocks({
      matching: (b: Block) => NOTABLE_BLOCK_PREDICATE(b.name),
      maxDistance: this.opts.perceptionRadius,
      count: limit * 4,
    });
    const seen = new Map<string, BlockView[]>();
    const out: BlockView[] = [];
    for (const p of positions) {
      const b = bot.blockAt(p);
      if (!b) continue;
      // de-duplicate large liquid bodies: keep only the 3 nearest water/lava blocks
      const list = seen.get(b.name) ?? [];
      if ((b.name === 'water' || b.name === 'lava') && list.length >= 3) continue;
      const view: BlockView = { name: b.name, position: { x: p.x, y: p.y, z: p.z }, distance: round(distance(me, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 })) };
      list.push(view);
      seen.set(b.name, list);
      out.push(view);
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, limit);
  }

  private countNearby(radius: number): Record<string, number> {
    const bot = this.bot;
    const base = bot.entity.position.floored();
    const counts: Record<string, number> = {};
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const b = bot.blockAt(base.offset(dx, dy, dz));
          if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
          counts[b.name] = (counts[b.name] ?? 0) + 1;
        }
      }
    }
    // keep the top 25 to bound the payload
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25));
  }
}

/** Servers (and test servers) sometimes omit stats; never let a NaN reach the mind. */
/**
 * What a dropped-item entity holds. Servers (and server emulators) disagree on item metadata encoding;
 * one odd entity must never break the whole observation, so failures read as "an item, unknown".
 */
export function droppedItemOf(entity: Entity): { name: string; count: number } | null {
  try {
    const item = (entity as unknown as { getDroppedItem?: () => Item | null }).getDroppedItem?.();
    return item ? { name: item.name, count: item.count } : null;
  } catch {
    return null;
  }
}

export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function toItemStack(item: Item | null | undefined): ItemStack | null {
  if (!item) return null;
  const out: ItemStack = { name: item.name, displayName: item.displayName, count: item.count, slot: item.slot };
  const maxDur = (item as unknown as { maxDurability?: number }).maxDurability;
  const dmg = (item as unknown as { durabilityUsed?: number }).durabilityUsed;
  if (typeof maxDur === 'number' && maxDur > 0) {
    out.maxDurability = maxDur;
    out.durability = maxDur - (dmg ?? 0);
  }
  const ench = (item as unknown as { enchants?: { name: string; lvl: number }[] }).enchants;
  if (ench && ench.length) out.enchants = ench.map((e) => `${e.name}:${e.lvl}`);
  return out;
}
