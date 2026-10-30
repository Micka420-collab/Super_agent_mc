/**
 * A deterministic fake Mineflayer bot for unit tests and fixture generation (no server needed).
 * Flat stone world at y=63, a small oak tree, a chest, a zombie and a player nearby.
 */
import minecraftData from 'minecraft-data';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

export const FAKE_VERSION = '1.21.11';

export interface FakeBlock {
  name: string;
  position: Vec3;
  type: number;
  light: number;
  skyLight: number;
  hardness: number;
  diggable: boolean;
  boundingBox: 'block' | 'empty';
  shapes: number[][];
  biome: { name: string };
  displayName: string;
}

export function createFakeBot(overrides: Partial<Record<string, unknown>> = {}): Bot {
  const registry = minecraftData(FAKE_VERSION);
  const solids = new Map<string, string>();
  const put = (x: number, y: number, z: number, name: string) => solids.set(`${x},${y},${z}`, name);
  // floor
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) {
    put(x, 63, z, 'grass_block');
    put(x, 62, z, 'dirt');
    put(x, 61, z, 'stone');
  }
  // tree at (6, 64..68, -3)
  for (let y = 64; y <= 68; y++) put(6, y, -3, 'oak_log');
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = 67; y <= 70; y++) if (!(dx === 0 && dz === 0 && y <= 68)) put(6 + dx, y, -3 + dz, 'oak_leaves');
  put(-3, 64, 2, 'chest');
  put(2, 64, -1, 'crafting_table');
  put(10, 64, 10, 'water');

  const blockAt = (p: Vec3): FakeBlock => {
    const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    const name = solids.get(key) ?? 'air';
    const def = registry.blocksByName[name] ?? registry.blocksByName['air']!;
    const solid = name !== 'air' && name !== 'water' && name !== 'oak_leaves';
    return {
      name,
      displayName: def.displayName,
      position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
      type: def.id,
      light: name === 'air' ? 15 : 0,
      skyLight: 15,
      hardness: def.hardness ?? 1,
      diggable: def.diggable,
      boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block',
      shapes: solid || name === 'oak_leaves' ? [[0, 0, 0, 1, 1, 1]] : [],
      biome: { name: 'plains' },
    };
  };

  const raycast = (from: Vec3, dir: Vec3, range: number) => {
    // simple DDA-free stepping; good enough for tests
    const step = 0.25;
    for (let t = 0; t <= range; t += step) {
      const p = new Vec3(from.x + dir.x * t, from.y + dir.y * t, from.z + dir.z * t);
      const b = blockAt(p);
      if (b.name !== 'air' && b.name !== 'water') {
        return Object.assign(b, { intersect: p });
      }
    }
    return null;
  };

  const me = {
    id: 1,
    type: 'player',
    name: 'player',
    username: 'Emeth',
    position: new Vec3(0.5, 64, 0.5),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    height: 1.8,
    effects: {},
    equipment: [],
  };
  const zombie = { id: 2, type: 'mob', name: 'zombie', position: new Vec3(0.5, 64, -8.5), velocity: new Vec3(0, 0, -0.05), health: 20, height: 1.95, heldItem: null, metadata: [] };
  const steve = { id: 3, type: 'player', name: 'player', username: 'Steve', position: new Vec3(4.5, 64, 3.5), velocity: new Vec3(0, 0, 0), height: 1.8, heldItem: { name: 'diamond_sword' }, metadata: [] };
  const item = {
    id: 4,
    type: 'object',
    name: 'item',
    position: new Vec3(-2.5, 64, -2.5),
    velocity: new Vec3(0, 0, 0),
    height: 0.25,
    metadata: [],
    getDroppedItem: () => ({ name: 'oak_log', count: 2 }),
  };
  const entities: Record<string, unknown> = { 1: me, 2: zombie, 3: steve, 4: item };

  const stick = registry.itemsByName['stick']!;
  const planks = registry.itemsByName['oak_planks']!;
  const bread = registry.itemsByName['bread']!;
  const items = [
    { name: 'oak_planks', displayName: 'Oak Planks', type: planks.id, count: 12, slot: 36 },
    { name: 'stick', displayName: 'Stick', type: stick.id, count: 4, slot: 37 },
    { name: 'bread', displayName: 'Bread', type: bread.id, count: 3, slot: 9 },
  ];
  const slots: unknown[] = new Array(46).fill(null);
  for (const it of items) slots[it.slot] = it;

  const bot: Record<string, unknown> = {
    username: 'Emeth',
    version: FAKE_VERSION,
    registry,
    entity: me,
    entities,
    players: { Steve: { username: 'Steve', entity: steve, ping: 40, gamemode: 0 }, Emeth: { username: 'Emeth', entity: me, ping: 0, gamemode: 0 } },
    health: 17,
    food: 13,
    foodSaturation: 2.5,
    oxygenLevel: 20,
    experience: { level: 3, points: 12, progress: 0.4 },
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', difficulty: 'normal' },
    isRaining: false,
    thunderState: 0,
    isSleeping: false,
    quickBarSlot: 0,
    heldItem: items[0],
    time: { timeOfDay: 6000, day: 3 },
    inventory: {
      slots,
      items: () => items,
      count: (type: number) => items.filter((i) => i.type === type).reduce((s, i) => s + i.count, 0),
      emptySlotCount: () => 33,
    },
    world: { raycast },
    blockAt: (p: Vec3) => blockAt(p),
    blockAtCursor: () => blockAt(new Vec3(0.5, 65.6, -2.5)).name === 'air' ? null : blockAt(new Vec3(0.5, 65.6, -2.5)),
    canSeeBlock: () => true,
    canDigBlock: () => true,
    findBlock: ({ matching, maxDistance }: { matching: number | number[] | ((b: FakeBlock) => boolean); maxDistance: number }) => {
      const found = findBlocks({ matching, maxDistance, count: 1 });
      return found[0] ? blockAt(found[0]) : null;
    },
    findBlocks,
    getEquipmentDestSlot: (name: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, hand: 36, 'off-hand': 45 })[name] ?? 36,
    nearestEntity: (filter: (e: unknown) => boolean) => Object.values(entities).find((e) => e !== me && filter(e)) ?? null,
    on: () => bot,
    once: () => bot,
    removeListener: () => bot,
    emit: () => true,
    pathfinder: { stop() {}, setGoal() {}, setMovements() {}, goto: async () => {}, bestHarvestTool: () => null },
    clearControlStates() {},
    setControlState() {},
    chat() {},
    whisper() {},
    lookAt: async () => {},
    look: async () => {},
    stopDigging() {},
    ...overrides,
  };

  function findBlocks({ matching, maxDistance, count }: { matching: number | number[] | ((b: FakeBlock) => boolean); maxDistance: number; count?: number }): Vec3[] {
    const out: Vec3[] = [];
    const matcher = typeof matching === 'function' ? matching : (b: FakeBlock) => (Array.isArray(matching) ? matching.includes(b.type) : b.type === matching);
    for (const key of solids.keys()) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      const p = new Vec3(x, y, z);
      if (p.distanceTo(me.position) > maxDistance) continue;
      if (matcher(blockAt(p))) out.push(p);
      if (count && out.length >= count) break;
    }
    return out.sort((a, b) => a.distanceTo(me.position) - b.distanceTo(me.position));
  }

  return bot as unknown as Bot;
}
