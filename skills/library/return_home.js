/** @skill return_home
 * description: Walks back to `home` {x,y,z} (a bed, a chest, a base from memory). If the pathfinder finds no route — typically because the agent is lost underground — it climbs out first: a careful 1x1 shaft straight up, checking every ceiling block for water, lava, gravel and sand before digging it, pillaring on any cheap block carried, until the sky is visible, then tries the walk again. Returns the final distance to home and what it had to do. args: {home: {x: number, y: number, z: number}, range?: number}
 * tags: navigation, survival, seed
 * version: 1
 */
async function main(api, args) {
  if (!args.home || typeof args.home.x !== 'number') throw Object.assign(new Error('return_home needs args.home = {x, y, z}'), { code: 'BAD_REQUEST' });
  const home = { x: args.home.x, y: args.home.y, z: args.home.z };
  const range = Math.max(1, Math.min(8, args.range || 2));
  const log = [];
  const tryWalk = async () => {
    try {
      await api.goto({ x: home.x, y: home.y, z: home.z, range, timeoutMs: 90000 });
      return true;
    } catch (err) {
      log.push(`walk failed: ${err.code || ''} ${err.message}`);
      if (err.code === 'INTERRUPTED') throw err;
      return false;
    }
  };
  let obs = await api.observe();
  const dist = () => api.distance(obs.self.position, home);
  if (dist() <= range || (await tryWalk())) {
    obs = await api.observe();
    return { arrived: dist() <= range + 1, distance: Math.round(dist()), log };
  }

  // no route: are we underground? (no sky light where we stand)
  obs = await api.observe();
  if (obs.world.skyLight > 0) {
    // outdoors but blocked (ravine, ocean, cliff): one exploration nudge then one more try
    await api.explore({ direction: 'random', maxSeconds: 30 });
    if (await tryWalk()) {
      obs = await api.observe();
      return { arrived: true, distance: Math.round(dist()), log };
    }
    throw Object.assign(new Error('cannot find a way home from here: ' + log.join(' | ')), { code: 'NO_PATH' });
  }

  // climb out: 1x1 shaft upward, never dig into liquids or falling blocks
  const PILLAR = ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'oak_planks', 'spruce_planks', 'birch_planks'];
  const UNSAFE = ['water', 'flowing_water', 'lava', 'flowing_lava', 'gravel', 'sand', 'red_sand', 'bubble_column', 'magma_block'];
  let climbed = 0;
  for (let i = 0; i < 64; i++) {
    if (api.aborted()) break;
    obs = await api.observe();
    if (obs.world.skyLight > 0) break;
    const p = obs.self.position;
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    // what is above our head, and above that (liquids/gravel two blocks up would fall on us when we dig)
    const above = await api.scan_region({ min: { x, y: y + 2, z }, max: { x, y: y + 3, z }, skipAir: false });
    if (above.unloaded > 0) { log.push('ceiling not loaded, stopping the climb'); break; }
    const ceiling = above.blocks.find((b) => b.y === y + 2);
    const higher = above.blocks.find((b) => b.y === y + 3);
    if ((ceiling && UNSAFE.includes(ceiling.name)) || (higher && UNSAFE.includes(higher.name))) {
      log.push(`unsafe block above (${(ceiling && ceiling.name) || ''}/${(higher && higher.name) || ''}), sidestepping`);
      // move one block sideways to find a safer column
      await api.move({ control: 'forward', ms: 400 }).catch(() => null);
      continue;
    }
    if (ceiling && ceiling.name === 'bedrock') { log.push('bedrock above?!'); break; }
    if (ceiling && ceiling.name !== 'air' && ceiling.name !== 'cave_air') {
      await api.dig({ x, y: y + 2, z, collect: false });
    }
    // pillar up one block: a block under our feet while jumping
    const inv = {};
    for (const it of obs.inventory.items) inv[it.name] = (inv[it.name] || 0) + it.count;
    const material = PILLAR.find((n) => (inv[n] || 0) > 0);
    if (!material) {
      // dig a few blocks of stone/dirt from the wall to pillar with
      const got = await api.mine({ name: inv['wooden_pickaxe'] || inv['stone_pickaxe'] || inv['iron_pickaxe'] ? 'stone' : 'dirt', count: 8, maxDistance: 6 }).catch(() => null);
      if (!got) throw Object.assign(new Error('nothing to pillar with and nothing to dig nearby'), { code: 'MISSING_ITEM' });
      continue;
    }
    await api.jump({});
    await api.sleep(150);
    try {
      await api.place({ name: material, x, y, z });
      climbed += 1;
    } catch (err) {
      log.push(`pillar step failed: ${err.message}`);
      await api.sleep(300);
    }
  }
  log.push(`climbed ${climbed} blocks`);
  const arrived = await tryWalk();
  obs = await api.observe();
  return { arrived, distance: Math.round(dist()), climbed, log };
}
