/** @skill emergency_shelter
 * description: Night is falling or monsters are near: encloses the agent in a 1x3 hut made of whatever cheap blocks it carries (dirt, cobblestone, planks...), lights it with a torch if available, and returns what was used. Dig first if nothing is in the inventory. args: {material?: string}
 * tags: survival, shelter, seed
 * version: 2
 */
async function main(api, args) {
  const CHEAP = ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack', 'oak_planks', 'spruce_planks', 'birch_planks', 'stone', 'andesite', 'diorite', 'granite', 'sand'];
  let obs = await api.observe();
  const inv = {};
  for (const it of obs.inventory.items) inv[it.name] = (inv[it.name] || 0) + it.count;
  let material = args.material && inv[args.material] >= 13 ? args.material : null;
  if (!material) {
    for (const name of CHEAP) if ((inv[name] || 0) >= 13) { material = name; break; }
  }
  if (!material) {
    // dig some dirt/stone right here
    api.log('no blocks to build with, digging some');
    const res = await api.mine({ name: inv['wooden_pickaxe'] || inv['stone_pickaxe'] ? 'stone' : 'dirt', count: 14, maxDistance: 12 });
    await api.collect_items({ radius: 6, maxItems: 10 });
    obs = await api.observe();
    for (const it of obs.inventory.items) inv[it.name] = (inv[it.name] || 0) + it.count;
    material = (res.inventoryDelta && Object.keys(res.inventoryDelta).find((k) => CHEAP.includes(k) && res.inventoryDelta[k] > 0)) || CHEAP.find((n) => (inv[n] || 0) >= 13);
    if (!material) throw Object.assign(new Error('still no blocks to build a shelter'), { code: 'MISSING_ITEM' });
  }
  const p = obs.self.position;
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
  // walls 3 high around the cell the agent stands in, a roof on top: one free cell above the head for a torch
  const cells = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let dy = 0; dy < 3; dy++) cells.push({ name: material, x: x + dx, y: y + dy, z: z + dz });
  }
  cells.push({ name: material, x, y: y + 3, z });
  const result = await api.build({ blocks: cells, partial: true });
  if (result.placed === 0 && result.failureCount > 0) {
    // seen live: "succeeded" with 0 placed and 4 failed, in the water at night — an empty shelter is not a shelter
    throw Object.assign(new Error(`could not place any of the shelter blocks (${result.failureCount} failed)`), { code: 'NO_PATH' });
  }
  let lit = false;
  if ((inv['torch'] || 0) > 0) {
    try {
      // the free cell above the head; the torch hangs on an adjacent wall block
      await api.place({ name: 'torch', x, y: y + 2, z });
      lit = true;
    } catch (err) {
      api.log('could not place a torch:', err.message);
    }
  }
  api.log(`shelter: ${result.placed} placed, ${result.failureCount} failed`);
  return { material, placed: result.placed, failed: result.failureCount, lit, position: { x, y, z } };
}
