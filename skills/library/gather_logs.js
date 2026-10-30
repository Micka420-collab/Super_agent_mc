/** @skill gather_logs
 * description: Collect wood logs of any type: finds the nearest trees (exploring if none are in view), mines `count` logs, picks up the drops, and returns the inventory delta. args: {count?: number (default 6), maxDistance?: number (default 48)}
 * tags: gather, wood, seed
 * version: 1
 */
async function main(api, args) {
  const want = Math.max(1, Math.min(64, Number(args.count) || 6));
  const maxDistance = Math.max(8, Math.min(96, Number(args.maxDistance) || 48));
  const before = await api.observe();
  const logsBefore = countLogs(before.inventory.items);
  let explored = 0;
  let found = await api.find_blocks({ names: ['log'], maxDistance, count: 16 });
  while (found.blocks.length === 0 && explored < 3) {
    if (api.aborted()) throw new Error('aborted while looking for trees');
    api.log('no trees in sight, exploring');
    const result = await api.explore({ direction: 'random', maxSeconds: 30, lookFor: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'] });
    explored += 1;
    if (result.found) api.log('spotted', result.found.name || result.found.kind);
    found = await api.find_blocks({ names: ['log'], maxDistance, count: 16 });
  }
  if (found.blocks.length === 0) {
    throw Object.assign(new Error('could not find any trees nearby after exploring'), { code: 'NOT_FOUND' });
  }
  let mined = 0;
  let rounds = 0;
  while (mined < want && rounds < 6) {
    if (api.aborted()) break;
    const logName = found.blocks[0].name;
    const res = await api.mine({ name: logName, count: Math.min(want - mined, 8), maxDistance });
    mined += res.mined || 0;
    rounds += 1;
    await api.collect_items({ radius: 8, maxItems: 10 });
    found = await api.find_blocks({ names: ['log'], maxDistance, count: 16 });
    if (found.blocks.length === 0) break;
  }
  const after = await api.observe();
  const gained = countLogs(after.inventory.items) - logsBefore;
  api.log(`gathered ${gained} logs in ${rounds} rounds`);
  return { requested: want, gained, mined, explored };
}

function countLogs(items) {
  let n = 0;
  for (const it of items) if (it.name.endsWith('_log')) n += it.count;
  return n;
}
