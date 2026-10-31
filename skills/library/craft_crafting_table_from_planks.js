/** @skill craft_crafting_table_from_planks
 * description: Crafts a crafting_table from spruce_planks (or any planks) in inventory, then verifies the crafting_table is in inventory. Args: {count?: number (tables wanted, default 1)}. Use when you need a crafting table and have at least 4 planks per table.
 * tags: auto, verified
 * version: 1
 * updated: 2026-10-30T18:22:56
 */
async function main(api, args) {
  const want = Math.max(1, Math.min(8, Number(args.count) || 1));
  const countOf = async (pred) => {
    const obs = await api.observe();
    return obs.inventory.items.filter((it) => pred(it.name)).reduce((s, it) => s + it.count, 0);
  };
  const isPlanks = (n) => n.endsWith('_planks');
  const tablesBefore = await countOf((n) => n === 'crafting_table');
  const planksBefore = await countOf(isPlanks);
  const needPlanks = want * 4;
  if (planksBefore < needPlanks) {
    throw Object.assign(new Error('need ' + needPlanks + ' planks, have ' + planksBefore), { code: 'MISSING_ITEM' });
  }
  await api.craft({ name: 'crafting_table', count: want });
  const tablesAfter = await countOf((n) => n === 'crafting_table');
  const planksAfter = await countOf(isPlanks);
  if (tablesAfter < tablesBefore + want) {
    throw Object.assign(new Error('crafting_table count ' + tablesAfter + ' after craft, expected at least ' + (tablesBefore + want)), { code: 'VERIFY_FAILED' });
  }
  api.log('crafting_table in inventory:', tablesAfter, 'planks left:', planksAfter);
  return { crafted: tablesAfter - tablesBefore, craftingTables: tablesAfter, planksLeft: planksAfter };
}