import { z } from 'zod';
import { Vec3 } from 'vec3';
import { BodyError, ErrorCodes } from '../protocol.js';
import { equipByName, findItem } from '../motor/items.js';
import { goToBlock } from '../motor/movement.js';
import { raceAbort, sleep } from '../util/async.js';
import { defineAction } from './registry.js';

/** Minecraft chat limit is 256 characters; we split long messages on word boundaries. */
export function splitChat(text: string, max = 250): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const parts: string[] = [];
  let current = '';
  for (const word of clean.split(' ')) {
    if ((current + ' ' + word).trim().length > max) {
      if (current) parts.push(current.trim());
      current = word.length > max ? word.slice(0, max) : word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) parts.push(current.trim());
  return parts;
}

/** Commands are never sent from the social layer — the agent is a player, not an admin. */
export function sanitizeChat(text: string): string {
  const t = text.trim();
  if (t.startsWith('/')) return t.replace(/^\/+/, '');
  return t;
}

defineAction({
  name: 'say',
  category: 'social',
  description: 'Say something in public chat (long messages are split; never sends commands).',
  longRunning: false,
  schema: z.object({ text: z.string().min(1).max(2000) }),
  async run(ctx, a) {
    const parts = splitChat(sanitizeChat(a.text));
    for (const p of parts) {
      ctx.bot.chat(p);
      ctx.observer.pushChat({ ts: Date.now(), from: ctx.bot.username, text: p, type: 'chat' });
      if (parts.length > 1) await sleep(350, ctx.signal);
    }
    return { sent: parts.length };
  },
});

defineAction({
  name: 'whisper',
  category: 'social',
  description: 'Send a private message to a player.',
  longRunning: false,
  schema: z.object({ to: z.string().min(1), text: z.string().min(1).max(2000) }),
  async run(ctx, a) {
    const parts = splitChat(sanitizeChat(a.text));
    for (const p of parts) {
      ctx.bot.whisper(a.to, p);
      ctx.observer.pushChat({ ts: Date.now(), from: `${ctx.bot.username}→${a.to}`, text: p, type: 'whisper' });
      if (parts.length > 1) await sleep(350, ctx.signal);
    }
    return { sent: parts.length, to: a.to };
  },
});

defineAction({
  name: 'write_book',
  category: 'social',
  description: 'Write pages into a writable book held in the inventory (the agent\'s in-world diary / letters to players).',
  longRunning: false,
  schema: z.object({
    pages: z.array(z.string().max(1000)).min(1).max(100),
  }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const book = findItem(bot, 'writable_book');
    if (!book) throw new BodyError(ErrorCodes.MISSING_ITEM, 'no writable_book in inventory (craft one: book + ink sac + feather)');
    await equipByName(bot, 'writable_book', 'hand');
    await raceAbort(bot.writeBook(book.slot, a.pages.map((p) => p.slice(0, 255 * 4))), ctx.signal, { timeoutMs: 5_000 });
    return { pages: a.pages.length };
  },
});

defineAction({
  name: 'write_sign',
  category: 'social',
  description: 'Write text on a sign block (up to 4 lines of ~15 chars).',
  longRunning: true,
  schema: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), lines: z.array(z.string().max(15)).min(1).max(4) }),
  async run(ctx, a) {
    const bot = ctx.bot;
    const block = bot.blockAt(new Vec3(a.x, a.y, a.z));
    if (!block || !block.name.includes('sign')) throw new BodyError(ErrorCodes.NOT_FOUND, `no sign at ${a.x},${a.y},${a.z}`);
    await goToBlock(bot, block.position, ctx.signal);
    bot.updateSign(block, a.lines.join('\n'));
    return { written: a.lines };
  },
});

defineAction({
  name: 'look_at_player',
  category: 'social',
  description: 'Look at a player\'s face (social presence while talking).',
  longRunning: false,
  schema: z.object({ username: z.string() }),
  async run(ctx, a) {
    const p = ctx.bot.players[a.username]?.entity;
    if (!p) throw new BodyError(ErrorCodes.NOT_FOUND, `${a.username} is not nearby`);
    await ctx.bot.lookAt(p.position.offset(0, (p as unknown as { height?: number }).height ?? 1.62, 0), true);
    return { lookingAt: a.username };
  },
});
