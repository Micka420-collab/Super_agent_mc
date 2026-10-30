/** @skill safe_staircase_mine
 * description: Digs a safe 1-wide descending staircase (3 blocks cleared per step) in the direction the agent faces or in `direction` (north/south/east/west), for up to `depth` steps (default 12), scanning around each step for lava, water and unloaded chunks before digging, planting a torch every `torchEvery` steps (default 6), stopping on low health, and reporting every ore and item collected plus the exact position where it stopped so the agent can come back. Needs a pickaxe. args: {depth?: number, direction?: string, torchEvery?: number, minHealth?: number}
 * tags: mining, survival, seed
 * version: 1
 */
async function main(api, args) {
  const depth = Math.max(1, Math.min(32, args.depth || 12));
  const torchEvery = Math.max(2, Math.min(16, args.torchEvery || 6));
  const minHealth = args.minHealth || 8;
  let obs = await api.observe();
  const hasPickaxe = obs.inventory.items.some((it) => it.name.endsWith('_pickaxe'));
  if (!hasPickaxe) throw Object.assign(new Error('a pickaxe is needed to dig a staircase'), { code: 'MISSING_TOOL' });

  // direction: explicit, else the dominant axis of where we look (mineflayer: dx = -sin(yaw), dz = -cos(yaw))
  const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
  let dir = DIRS[args.direction];
  if (!dir) {
    const dx = -Math.sin(obs.self.yaw), dz = -Math.cos(obs.self.yaw);
    dir = Math.abs(dx) > Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
  }
  const [dx, dz] = dir;
  const p = obs.self.position;
  const x0 = Math.floor(p.x), y0 = Math.floor(p.y), z0 = Math.floor(p.z);

  const DANGER = ['lava', 'flowing_lava', 'water', 'flowing_water', 'bubble_column', 'magma_block', 'fire', 'soul_fire'];
  const gained = {};
  const addDelta = (delta) => {
    for (const k in delta || {}) if (delta[k] > 0) gained[k] = (gained[k] || 0) + delta[k];
  };
  let steps = 0;
  let stoppedBecause = 'reached the requested depth';
  let torches = 0;
  let pos = { x: x0, y: y0, z: z0 };

  for (let i = 1; i <= depth; i++) {
    if (api.aborted()) { stoppedBecause = 'interrupted'; break; }
    const sx = x0 + dx * i, sy = y0 - i, sz = z0 + dz * i;
    // look around the next step before touching anything: one block of margin on every side, down to the floor below
    const survey = await api.scan_region({ min: { x: sx - 1, y: sy - 1, z: sz - 1 }, max: { x: sx + 1, y: sy + 2, z: sz + 1 }, skipAir: false });
    if (survey.unloaded > 0) { stoppedBecause = 'unloaded blocks ahead — not digging blind'; break; }
    const danger = Object.keys(survey.counts).find((n) => DANGER.includes(n));
    if (danger) { stoppedBecause = `${danger} detected next to the next step`; break; }
    if (survey.counts.bedrock) { stoppedBecause = 'bedrock reached'; break; }
    const floor = survey.blocks.find((b) => b.x === sx && b.y === sy - 1 && b.z === sz);
    if (!floor || floor.name === 'air' || floor.name === 'cave_air') { stoppedBecause = 'a hole under the next step (cave?)'; break; }

    // clear feet, head and the block above so we can walk down without bumping
    for (const y of [sy + 2, sy + 1, sy]) {
      const cell = survey.blocks.find((b) => b.x === sx && b.y === y && b.z === sz);
      if (!cell || cell.name === 'air' || cell.name === 'cave_air') continue;
      const res = await api.dig({ x: sx, y, z: sz, collect: false });
      addDelta(res.inventoryDelta);
    }
    await api.goto({ x: sx + 0.5, y: sy, z: sz + 0.5, range: 0.8 });
    pos = { x: sx, y: sy, z: sz };
    steps += 1;
    await api.collect_items({ radius: 3, maxItems: 4 }).catch(() => null);

    if (i % torchEvery === 0) {
      obs = await api.observe();
      if (obs.inventory.items.some((it) => it.name === 'torch')) {
        try {
          await api.place({ name: 'torch', x: sx, y: sy + 1, z: sz });
          torches += 1;
        } catch (err) {
          api.log('no wall for a torch here:', err.message);
        }
      }
    }
    obs = await api.observe();
    if (obs.self.health < minHealth) { stoppedBecause = `health ${obs.self.health} below ${minHealth}`; break; }
    if (obs.inventory.freeSlots === 0) { stoppedBecause = 'inventory full'; break; }
  }
  api.log(`staircase: ${steps} steps down, stopped: ${stoppedBecause}`);
  return { steps, direction: dx === 1 ? 'east' : dx === -1 ? 'west' : dz === 1 ? 'south' : 'north', bottom: pos, torches, gained, stoppedBecause };
}
