/**
 * Generate the shared protocol fixtures (validated by both the TS and the Python test suites).
 *   npx tsx src/tools/gen-fixtures.ts ../protocol/fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import '../actions/index.js';
import { buildManifest, buildSkillApiDoc } from '../actions/registry.js';
import { Observer } from '../perception/observer.js';
import { createFakeBot } from '../testing/fakeBot.js';
import {
  ActionResultSchema,
  HelloResultSchema,
  ObservationSchema,
  PROTOCOL_VERSION,
  SkillRunResultSchema,
  type ActionResult,
  type HelloResult,
  type SkillRunResult,
} from '../protocol.js';

const outDir = process.argv[2] ?? path.join(process.cwd(), '..', 'protocol', 'fixtures');
mkdirSync(outDir, { recursive: true });

const bot = createFakeBot();
const observer = new Observer(bot);
observer.pushChat({ ts: 1_700_000_000_000, from: 'Steve', text: 'salut Emeth, tu fais quoi ?', type: 'chat' });
observer.pushEvent('hurt', 'took 3 damage (health 17)', 1_700_000_001_000);
const observation = observer.observe('compact');
observation.ts = 1_700_000_002_000;
observation.tick = 1234;
ObservationSchema.parse(observation);

const hello: HelloResult = {
  protocol: PROTOCOL_VERSION,
  body: { name: '@emeth/body', version: '0.1.0' },
  minecraft: { version: '1.21.11', host: '127.0.0.1', port: 25565, username: 'Emeth' },
  capabilities: { vision: 'retina', skills: true, reflexes: true },
  actions: buildManifest(),
  skillApiDoc: buildSkillApiDoc(),
};
HelloResultSchema.parse(hello);

const actionResult: ActionResult = {
  id: '7f2a1c3e-0000-4000-8000-000000000001',
  action: 'mine',
  ok: true,
  result: { requested: 3, mined: 3, inventoryDelta: { oak_log: 3 } },
  startedAt: 1_700_000_003_000,
  finishedAt: 1_700_000_009_500,
};
ActionResultSchema.parse(actionResult);

const actionFailure: ActionResult = {
  id: '7f2a1c3e-0000-4000-8000-000000000002',
  action: 'craft',
  ok: false,
  error: 'cannot craft iron_pickaxe: missing 3 iron_ingot',
  errorCode: 'MISSING_ITEM',
  result: { missing: [{ name: 'iron_ingot', missing: 3 }] },
  startedAt: 1_700_000_010_000,
  finishedAt: 1_700_000_010_120,
};
ActionResultSchema.parse(actionFailure);

const skillResult: SkillRunResult = {
  id: '7f2a1c3e-0000-4000-8000-000000000003',
  name: 'gather_logs',
  ok: false,
  error: 'no oak_log within 32 blocks — explore first',
  errorCode: 'NOT_FOUND',
  logs: ['looking for logs'],
  trace: [
    { t: 12, call: 'observe', ok: true, ms: 4 },
    { t: 30, call: 'find_blocks', ok: true, ms: 9 },
    { t: 45, call: 'mine', ok: false, ms: 120, error: 'no oak_log within 32 blocks — explore first' },
  ],
  startedAt: 1_700_000_011_000,
  finishedAt: 1_700_000_011_200,
  interruptedBy: undefined,
};
SkillRunResultSchema.parse(skillResult);

const envelopes = {
  request: { kind: 'request', id: 'req-1', method: 'act', params: { action: 'goto', args: { x: 10, y: 64, z: -3, range: 1 } } },
  response_ok: { kind: 'response', id: 'req-1', ok: true, result: actionResult },
  response_error: { kind: 'response', id: 'req-2', ok: false, error: { code: 'UNKNOWN_ACTION', message: 'unknown action: teleport' } },
  event_chat: { kind: 'event', event: 'chat', ts: 1_700_000_012_000, payload: { from: 'Steve', text: 'viens voir', ts: 1_700_000_012_000 } },
  event_reflex: { kind: 'event', event: 'reflex', ts: 1_700_000_013_000, payload: { name: 'defend', phase: 'start', reason: 'zombie at 2.5m (attacking me)', priority: 60 } },
};

const files: Record<string, unknown> = {
  'observation.json': observation,
  'hello.json': hello,
  'action-result.json': actionResult,
  'action-failure.json': actionFailure,
  'skill-result.json': skillResult,
  'envelopes.json': envelopes,
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(files).length} fixtures to ${outDir}`);
