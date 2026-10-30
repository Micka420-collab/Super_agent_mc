import { describe, expect, it } from 'vitest';
import { Observer } from '../src/perception/observer.js';
import { createFakeBot } from '../src/testing/fakeBot.js';
import { ObservationSchema } from '../src/protocol.js';
import { RetinaVision } from '../src/vision/index.js';

describe('observer', () => {
  it('builds a schema-valid observation from the world', () => {
    const bot = createFakeBot();
    const observer = new Observer(bot);
    observer.pushChat({ ts: 1, from: 'Steve', text: 'hello there', type: 'chat' });
    observer.pushEvent('hurt', 'took 3 damage');
    const obs = observer.observe('compact');
    const parsed = ObservationSchema.safeParse(obs);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues, null, 1)).toBe(true);

    expect(obs.self.username).toBe('Emeth');
    expect(obs.self.health).toBe(17);
    expect(obs.self.biome).toBe('plains');
    expect(obs.world.phase).toBe('day');
    expect(obs.blocks.standingOn).toBe('grass_block');
    expect(obs.inventory.items.map((i) => i.name)).toContain('bread');
    expect(obs.inventory.hotbar[0]?.name).toBe('oak_planks');

    // entities classified into buckets with bearings
    expect(obs.entities.hostiles[0]?.name).toBe('zombie');
    expect(obs.entities.hostiles[0]?.bearing).toBe('N');
    expect(obs.entities.hostiles[0]?.relative).toBe('ahead');
    expect(obs.entities.players[0]?.username).toBe('Steve');
    expect(obs.entities.players[0]?.heldItem).toBe('diamond_sword');
    expect(obs.entities.items[0]?.itemName).toBe('oak_log');

    // notable blocks include the chest, the table and water (de-duplicated)
    const notable = obs.blocks.notable.map((b) => b.name);
    expect(notable).toContain('chest');
    expect(notable).toContain('crafting_table');
    expect(notable).toContain('water');
    expect(obs.blocks.nearbyCounts['grass_block']).toBeGreaterThan(50);

    // the FOV scan sees the ground and the tree (north-east, inside 110° FOV)
    expect(obs.vision?.visible.some((v) => v.name === 'grass_block')).toBe(true);
    expect(obs.vision?.visible.some((v) => v.name === 'oak_log' || v.name === 'oak_leaves')).toBe(true);
    expect(obs.chat[0]?.from).toBe('Steve');
    expect(obs.events[0]?.event).toBe('hurt');
  });

  it('honest perception hides entities without line of sight', () => {
    const bot = createFakeBot({ world: { raycast: () => ({ name: 'stone', position: { x: 0, y: 64, z: -1 }, intersect: { x: 0.5, y: 65, z: -1 } }) } });
    const observer = new Observer(bot, { honestPerception: true, perceptionRadius: 32, fovDeg: 110, chatBufferSize: 5, eventBufferSize: 5 });
    const obs = observer.observe('compact');
    expect(obs.entities.hostiles).toHaveLength(0); // the wall hides the zombie
  });

  it('renders a retina frame with entity markers from the same world', async () => {
    const bot = createFakeBot();
    const observer = new Observer(bot);
    const vision = new RetinaVision(bot, observer);
    const frame = await vision.render({ width: 64, height: 36, fovDeg: 110, maxDistance: 48 });
    expect(frame.width).toBe(64);
    expect(Object.values(frame.legend)).toContain('entity:hostile');
    expect(frame.description.length).toBeGreaterThan(10);
  });
});

describe('dropped items', () => {
  it('never lets a malformed item entity break perception', async () => {
    const { droppedItemOf } = await import('../src/perception/observer.js');
    const broken = { getDroppedItem: () => { throw new TypeError("Cannot read properties of undefined (reading 'present')"); } } as never;
    expect(droppedItemOf(broken)).toBeNull();
    const fine = { getDroppedItem: () => ({ name: 'oak_log', count: 3 }) } as never;
    expect(droppedItemOf(fine)).toEqual({ name: 'oak_log', count: 3 });
    expect(droppedItemOf({} as never)).toBeNull();
  });
});
