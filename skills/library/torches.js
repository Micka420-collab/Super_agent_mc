/** @skill torches
 * description: Makes sure the agent carries at least `count` torches (default 8) by running the procurement planner (coal or charcoal, sticks, pickaxe if needed) and, when `placeHere` is set and the spot is dark, plants one on the ground next to the agent. Returns how many torches are carried and what was done. args: {count?: number, placeHere?: boolean}
 * tags: light, survival, procurement, seed
 * version: 1
 */
async function main(api, args) {
  const want = Math.max(1, Math.min(64, args.count || 8));
  const count = async () => {
    const obs = await api.observe();
    return obs.inventory.items.filter((it) => it.name === 'torch').reduce((s, it) => s + it.count, 0);
  };
  const before = await count();
  const done = [];
  if (before < want) {
    // dry run first: the plan tells us whether this is realistic before we start digging
    const plan = await api.plan_get({ name: 'torch', count: want });
    api.log('torch plan:', plan.text);
    if (!plan.feasible) throw Object.assign(new Error('cannot get torches here: ' + plan.unresolved.join(', ')), { code: 'MISSING_ITEM' });
    const res = await api.get({ name: 'torch', count: want, maxSteps: 30 });
    done.push(...res.executed);
  }
  let placed = false;
  if (args.placeHere) {
    const obs = await api.observe();
    if (obs.world.lightLevel <= 7 && (await count()) > 0) {
      const p = obs.self.position;
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      // the torch stands on the ground beside us: first side with air at feet level and a floor under it
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dz] of sides) {
        const survey = await api.scan_region({ min: { x: x + dx, y: y - 1, z: z + dz }, max: { x: x + dx, y, z: z + dz }, skipAir: false });
        const floor = survey.blocks.find((b) => b.y === y - 1);
        const cell = survey.blocks.find((b) => b.y === y);
        const free = !cell || ['air', 'cave_air', 'short_grass', 'grass', 'tall_grass', 'fern'].includes(cell.name);
        if (floor && floor.name !== 'air' && floor.name !== 'water' && floor.name !== 'lava' && free) {
          try {
            await api.place({ name: 'torch', x: x + dx, y, z: z + dz });
            placed = true;
            break;
          } catch (err) {
            api.log('torch placement failed here:', err.message);
          }
        }
      }
    }
  }
  return { torches: await count(), gathered: done, placed };
}
