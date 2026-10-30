/**
 * Animal husbandry — the gentle side of procurement: wool without killing the sheep.
 */
import { z } from 'zod';
import { BodyError, ErrorCodes } from '../protocol.js';
import { approachEntity } from '../motor/movement.js';
import { countItem, equipByName, findItem, inventorySummary } from '../motor/items.js';
import { raceAbort, sleep, throwIfAborted } from '../util/async.js';
import { distance } from '../util/geometry.js';
import { inventoryDelta } from './mining.js';
import { defineAction, getAction } from './registry.js';

const WOOL_SUFFIX = '_wool';

defineAction({
  name: 'shear',
  category: 'survival',
  description: 'Shear nearby sheep with shears until `count` wool is collected (walks to each sheep, right-clicks it, picks up the wool). Needs shears; sheep regrow wool after grazing, so nothing dies.',
  longRunning: true,
  schema: z.object({
    count: z.number().int().min(1).max(64).default(3).describe('wool blocks wanted'),
    maxDistance: z.number().min(2).max(64).default(32),
    color: z.string().optional().describe('wool colour to count, e.g. "white_wool"; any wool when omitted'),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    if (!findItem(bot, 'shears')) throw new BodyError(ErrorCodes.MISSING_ITEM, 'I have no shears (2 iron ingots)');
    const wanted = (name: string) => (a.color ? name === a.color : name.endsWith(WOOL_SUFFIX));
    const woolCount = () => inventorySummary(bot).filter((i) => wanted(i.name)).reduce((s, i) => s + i.count, 0);
    const before = inventorySummary(bot);
    const start = woolCount();
    const tried = new Set<number>();
    let sheared = 0;
    while (woolCount() - start < a.count) {
      throwIfAborted(ctx.signal);
      const sheep = bot.nearestEntity((e) => e.name === 'sheep' && !tried.has(e.id) && distance(e.position, bot.entity.position) <= a.maxDistance);
      if (!sheep) break;
      tried.add(sheep.id);
      try {
        await approachEntity(bot, sheep, 2.5, ctx.signal, 30_000);
        await equipByName(bot, 'shears', 'hand');
        await bot.lookAt(sheep.position.offset(0, 0.8, 0), true);
        const had = woolCount();
        await raceAbort(bot.activateEntity(sheep), ctx.signal, { timeoutMs: 5_000 });
        await sleep(400, ctx.signal);
        // the wool drops at the sheep's feet: step over it
        await getAction('collect_items').run(ctx, { radius: 6, maxItems: 4 });
        if (woolCount() > had) sheared += 1;
        else ctx.progress(`that sheep had no wool to give (already sheared or a lamb)`);
      } catch (err) {
        if (err instanceof BodyError && err.code === ErrorCodes.INTERRUPTED) throw err;
        ctx.log.debug({ err }, 'shearing attempt failed');
      }
      if (tried.size >= 12) break;
    }
    const gained = woolCount() - start;
    if (gained === 0) {
      throw new BodyError(ErrorCodes.NOT_FOUND, tried.size ? `${tried.size} sheep nearby but no wool came off (already sheared?)` : `no sheep within ${a.maxDistance} blocks`);
    }
    return { sheared, wool: gained, shears: countItem(bot, 'shears'), inventoryDelta: inventoryDelta(before, inventorySummary(bot)) };
  },
});
