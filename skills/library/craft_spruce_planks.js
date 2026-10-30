/** @skill craft_spruce_planks
 * description: Crafts a requested number of spruce_planks from spruce_log in inventory (4 planks per log, no crafting table needed), then verifies the planks are in inventory. Args: {count?: number (planks wanted, default 12)}. Use when you need planks from spruce logs.
 * tags: auto, verified
 * version: 1
 * updated: 2026-10-30T18:22:49
 */
async function main(api, args) {
  const want = Math.max(1, Math.min(64, Number(args.count) || 12));
  const countOf = async (name) => {
    const obs = await api.observe();
    return obs.inventory.items.filter((it) => it.name === name).reduce((s, it) => s + it.count, 0);
  };
  const planksBefore = await countOf('spruce_planks');
  const logsBefore = await countOf('spruce_log');
  const needed = Math.max(0, want - planksBefore);
  if (needed === 0) {
    return { planks: planksBefore, crafted: 0, logsLeft: logsBefore, note: 'already have enough' };
  }
  const logsNeeded = Math.ceil(needed / 4);
  if (logsBefore < logsNeeded) {
    throw Object.assign(new Error('need ' + logsNeeded + ' spruce_log, have ' + logsBefore), { code: 'MISSING_ITEM' });
  }
  await api.craft({ name: 'spruce_planks', count: needed });
  const planksAfter = await countOf('spruce_planks');
  const logsAfter = await countOf('spruce_log');
  if (planksAfter < want) {
    throw Object.assign(new Error('planks after craft ' + planksAfter + ' < ' + want), { code: 'VERIFY_FAILED' });
  }
  api.log('spruce_planks now', planksAfter);
  return { planks: planksAfter, crafted: planksAfter - planksBefore, logsLeft: logsAfter };
}