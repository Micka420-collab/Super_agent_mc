// A human-like observer for the companion e2e: a second Minecraft client that joins the Paper server and reports, as
// JSON lines, what a person playing next to EMETH actually sees (boss bars, action bar, sidebar, the text display
// above the agent, the "inside its head" window, retina map pixels, chat). Driven line by line on stdin.
//
//   node observer.mjs <host> <port> <username> <path/to/body>
//   stdin:  {"cmd":"chat","text":"/emeth hud"} | {"cmd":"snapshot"} | {"cmd":"click","slot":38,"button":0}
//           {"cmd":"equipMap"} | {"cmd":"closeWindow"} | {"cmd":"quit"}
//   stdout: {"event":"spawn"} … then one {"ok":true,"result":…} per command.
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

const [host, port, username, bodyDir] = process.argv.slice(2);
const require = createRequire(path.resolve(bodyDir, 'package.json'));
const mineflayer = require('mineflayer');
const nbt = require('prismarine-nbt');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
// Text components reach 1.20.3+ clients as NBT; older paths give JSON strings or ChatMessage objects. Flatten all to text.
function flatten(component) {
  if (component == null) return '';
  if (typeof component === 'string') return component;
  if (Array.isArray(component)) return component.map(flatten).join('');
  let out = component.text ?? component.translate ?? component[''] ?? '';
  if (component.extra) out += flatten(component.extra);
  return String(out);
}
const text = (msg) => {
  if (msg == null) return '';
  if (typeof msg === 'string') {
    try { return flatten(JSON.parse(msg)); } catch { return msg; }
  }
  if (msg.type && msg.value !== undefined) {
    try { return flatten(nbt.simplify(msg)); } catch { /* fall through */ }
  }
  if (typeof msg.toString === 'function' && msg.toString !== Object.prototype.toString) return msg.toString();
  return flatten(msg);
};

const bot = mineflayer.createBot({ host, port: Number(port), username, auth: 'offline', hideErrors: true });
const bossLog = [];
const seen = { bossBars: new Map(), actionBar: '', chat: [], maps: new Map(), window: null, scores: new Map(), objective: null };

bot.on('message', (m, position) => { if (position !== 'game_info') seen.chat.push(text(m)); if (seen.chat.length > 50) seen.chat.shift(); });
bot.on('windowOpen', (w) => { seen.window = w; });
bot.on('windowClose', () => { seen.window = null; });
// raw packets: what the vanilla client renders, whatever mineflayer's own parsing supports
bot._client.on('action_bar', (p) => { seen.actionBar = text(p.text); });
bot._client.on('set_action_bar_text', (p) => { seen.actionBar = text(p.text); });
bot._client.on('boss_bar', (p) => {
  const id = p.entityUUID;
  bossLog.push({ t: Date.now(), action: p.action, title: p.title !== undefined ? text(p.title) : undefined });
  if (bossLog.length > 40) bossLog.shift();
  if (p.action === 1) { seen.bossBars.delete(id); return; }
  const prev = seen.bossBars.get(id) ?? { title: '', health: 0, color: 0 };
  if (p.title !== undefined) prev.title = text(p.title);
  if (p.health !== undefined) prev.health = p.health;
  if (p.color !== undefined) prev.color = p.color;
  seen.bossBars.set(id, prev);
});
bot._client.on('scoreboard_objective', (p) => {
  if (p.action === 1) {
    if (seen.objective?.name === p.name) { seen.objective = null; seen.scores.clear(); }
    return;
  }
  seen.objective = { name: p.name, title: text(p.displayText) };
});
bot._client.on('scoreboard_score', (p) => { seen.scores.set(p.itemName, { value: p.value, display: text(p.display_name ?? p.displayName) }); });
bot._client.on('reset_score', (p) => { seen.scores.delete(p.entity_name ?? p.entityName); });
bot._client.on('map', (p) => {
  if (!p.columns || !p.data) return;
  const data = Buffer.from(p.data);
  seen.maps.set(p.itemDamage ?? p.mapId ?? 0, { columns: p.columns, rows: p.rows, distinct: new Set(data).size, bytes: data.length });
});

function itemView(item) {
  if (!item) return null;
  let display = null;
  let lore = [];
  try { display = item.customName ? text(item.customName) : null; } catch { /* components vary by version */ }
  try { lore = (item.customLore ?? []).map(text); } catch { /* idem */ }
  return { name: item.name, count: item.count, display, lore };
}

function snapshot() {
  const entities = Object.values(bot.entities)
    .filter((e) => e !== bot.entity)
    .map((e) => ({ name: e.name, type: e.type, username: e.username ?? null, distance: Number(e.position.distanceTo(bot.entity.position).toFixed(1)), vehicle: e.vehicle ? (e.vehicle.username ?? e.vehicle.name) : null }));
  const w = seen.window;
  return {
    bossBars: [...seen.bossBars.values()],
    actionBar: seen.actionBar,
    sidebar: seen.objective ? { title: seen.objective.title, items: [...seen.scores.entries()].sort((a, b) => b[1].value - a[1].value).map(([name, v]) => ({ name, ...v })) } : null,
    entities,
    inventory: bot.inventory.items().map(itemView),
    window: w ? { title: text(w.title), type: w.type, slots: w.slots.slice(0, 54).map((s, i) => (s ? { slot: i, ...itemView(s) } : null)).filter(Boolean) } : null,
    maps: [...seen.maps.entries()].map(([id, m]) => ({ id, ...m })),
    chat: seen.chat.slice(-20),
    bossLog: bossLog.slice(-12),
  };
}

async function handle(cmd) {
  switch (cmd.cmd) {
    case 'chat': bot.chat(cmd.text); return { sent: cmd.text };
    case 'snapshot': return snapshot();
    case 'click': {
      if (!bot.currentWindow) throw new Error('no window open');
      await bot.clickWindow(cmd.slot, cmd.button ?? 0, 0);
      return { clicked: cmd.slot };
    }
    case 'closeWindow': if (bot.currentWindow) bot.closeWindow(bot.currentWindow); return { closed: true };
    case 'equipMap': {
      const map = bot.inventory.items().find((i) => i.name === 'filled_map');
      if (!map) throw new Error('no filled_map in inventory');
      await bot.equip(map, 'hand');
      return { equipped: map.name };
    }
    case 'lookAt': {
      const target = Object.values(bot.entities).find((e) => e.username === cmd.username);
      if (target) await bot.lookAt(target.position.offset(0, 1.6, 0), true);
      return { looked: !!target };
    }
    case 'quit': bot.quit('done'); setTimeout(() => process.exit(0), 300); return { quitting: true };
    default: throw new Error(`unknown cmd ${cmd.cmd}`);
  }
}

bot.once('spawn', () => {
  out({ event: 'spawn', position: bot.entity.position });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let cmd;
    try { cmd = JSON.parse(line); } catch { out({ ok: false, error: 'bad json' }); return; }
    try { out({ ok: true, cmd: cmd.cmd, result: await handle(cmd) }); } catch (err) { out({ ok: false, cmd: cmd.cmd, error: String(err?.message ?? err) }); }
  });
});
bot.on('kicked', (reason) => { out({ event: 'kicked', reason: text(reason) }); process.exit(2); });
bot.on('error', (err) => out({ event: 'error', error: String(err?.message ?? err) }));
