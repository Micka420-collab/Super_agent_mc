/** @skill bootstrap_tools
 * description: From nothing to a stone pickaxe, axe and sword: gathers logs, crafts planks, sticks and a crafting table, a wooden pickaxe, mines cobblestone, then crafts stone tools. Idempotent — skips steps already satisfied. args: {}
 * tags: craft, progression, seed
 * version: 1
 */
async function main(api, args) {
  const steps = [];
  const have = async (name) => {
    const obs = await api.observe();
    let n = 0;
    for (const it of obs.inventory.items) if (it.name === name || (name.endsWith('*') && it.name.endsWith(name.slice(0, -1)))) n += it.count;
    return n;
  };
  const anyPlanks = async () => {
    const obs = await api.observe();
    return obs.inventory.items.filter((it) => it.name.endsWith('_planks')).reduce((s, it) => s + it.count, 0);
  };

  // 1. wood
  const logs = (await api.observe()).inventory.items.filter((it) => it.name.endsWith('_log')).reduce((s, it) => s + it.count, 0);
  if (logs < 5 && (await anyPlanks()) < 12) {
    const res = await api.mine({ name: 'log', count: 6, maxDistance: 48 }).catch(async (err) => {
      if (err.code === 'NOT_FOUND') {
        await api.explore({ direction: 'random', maxSeconds: 30, lookFor: ['oak_log', 'birch_log', 'spruce_log'] });
        return api.mine({ name: 'log', count: 6, maxDistance: 48 });
      }
      throw err;
    });
    steps.push(`mined ${res.mined} logs`);
    await api.collect_items({ radius: 8, maxItems: 8 });
  }
  // 2. planks (keep enough for a table, sticks and a pickaxe)
  if ((await anyPlanks()) < 12) {
    const obs = await api.observe();
    const log = obs.inventory.items.find((it) => it.name.endsWith('_log'));
    if (!log) throw Object.assign(new Error('no logs to make planks'), { code: 'MISSING_ITEM' });
    const planks = log.name.replace('_log', '_planks');
    await api.craft({ name: planks, count: 12 });
    steps.push('crafted planks');
  }
  // 3. sticks
  if ((await have('stick')) < 6) {
    await api.craft({ name: 'stick', count: 8 });
    steps.push('crafted sticks');
  }
  // 4. wooden pickaxe (craft places a table when needed)
  const hasPick = (await have('*_pickaxe')) > 0;
  if (!hasPick) {
    await api.craft({ name: 'wooden_pickaxe', count: 1 });
    steps.push('crafted wooden pickaxe');
  }
  // 5. cobblestone
  if ((await have('cobblestone')) < 11) {
    const res = await api.mine({ name: 'stone', count: 12, maxDistance: 40 }).catch(async (err) => {
      if (err.code === 'NOT_FOUND') {
        await api.explore({ direction: 'random', maxSeconds: 30, lookFor: ['stone'] });
        return api.mine({ name: 'stone', count: 12, maxDistance: 40 });
      }
      throw err;
    });
    steps.push(`mined ${res.mined} stone`);
    await api.collect_items({ radius: 8, maxItems: 8 });
  }
  // 6. stone tools
  for (const tool of ['stone_pickaxe', 'stone_axe', 'stone_sword']) {
    if (api.aborted()) break;
    if ((await have(tool)) === 0) {
      if ((await have('stick')) < 2) await api.craft({ name: 'stick', count: 4 });
      await api.craft({ name: tool, count: 1 });
      steps.push(`crafted ${tool}`);
    }
  }
  await api.equip({ name: 'stone_pickaxe', destination: 'hand' }).catch(() => undefined);
  return { steps };
}
