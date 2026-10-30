/**
 * EMETH wire protocol — shared contract between the body (this package) and the mind (Python).
 *
 * Transport: WebSocket, one JSON document per frame.
 * Three envelope kinds:
 *   - request  (mind -> body): { kind:'request', id, method, params }
 *   - response (body -> mind): { kind:'response', id, ok, result | error }
 *   - event    (body -> mind): { kind:'event', event, ts, payload }
 *
 * The Python side mirrors these schemas with pydantic (mind/src/emeth/protocol.py) and both suites
 * validate the same fixtures in /protocol/fixtures — keep them in sync.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = '0.1.0';

// ---------------------------------------------------------------------------------------------
// Primitive value schemas
// ---------------------------------------------------------------------------------------------
export const Vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3Like = z.infer<typeof Vec3Schema>;

export const ItemStackSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  count: z.number().int().nonnegative(),
  slot: z.number().int().optional(),
  durability: z.number().optional(),
  maxDurability: z.number().optional(),
  enchants: z.array(z.string()).optional(),
});
export type ItemStack = z.infer<typeof ItemStackSchema>;

export const EntityKindSchema = z.enum(['player', 'hostile', 'passive', 'neutral', 'item', 'projectile', 'vehicle', 'other']);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const EntityViewSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: EntityKindSchema,
  username: z.string().optional(),
  position: Vec3Schema,
  distance: z.number(),
  /** Compass bearing from the bot ("N", "NE", ...) plus a relative hint ("left", "behind"). */
  bearing: z.string(),
  relative: z.string(),
  visible: z.boolean(),
  health: z.number().optional(),
  heldItem: z.string().optional(),
  itemName: z.string().optional(),
  itemCount: z.number().optional(),
  velocity: Vec3Schema.optional(),
  isBaby: z.boolean().optional(),
});
export type EntityView = z.infer<typeof EntityViewSchema>;

export const BlockViewSchema = z.object({
  name: z.string(),
  position: Vec3Schema,
  distance: z.number(),
  light: z.number().optional(),
});
export type BlockView = z.infer<typeof BlockViewSchema>;

export const ChatLineSchema = z.object({
  ts: z.number(),
  from: z.string(),
  text: z.string(),
  type: z.enum(['chat', 'whisper', 'system']),
});
export type ChatLine = z.infer<typeof ChatLineSchema>;

export const RecentEventSchema = z.object({
  ts: z.number(),
  event: z.string(),
  summary: z.string(),
});

// ---------------------------------------------------------------------------------------------
// Observation — what the body perceives, assembled by perception/observer.ts
// ---------------------------------------------------------------------------------------------
export const SelfStateSchema = z.object({
  username: z.string(),
  position: Vec3Schema,
  yaw: z.number(),
  pitch: z.number(),
  health: z.number(),
  food: z.number(),
  saturation: z.number(),
  oxygen: z.number(),
  xpLevel: z.number(),
  xpProgress: z.number(),
  gameMode: z.string(),
  dimension: z.string(),
  onGround: z.boolean(),
  isSleeping: z.boolean(),
  isInWater: z.boolean(),
  isInLava: z.boolean(),
  isOnFire: z.boolean(),
  velocity: Vec3Schema,
  heldItem: ItemStackSchema.nullable(),
  offhandItem: ItemStackSchema.nullable(),
  armor: z.object({
    head: z.string().nullable(),
    torso: z.string().nullable(),
    legs: z.string().nullable(),
    feet: z.string().nullable(),
  }),
  effects: z.array(z.object({ name: z.string(), amplifier: z.number(), durationTicks: z.number() })),
  biome: z.string(),
});

export const WorldStateSchema = z.object({
  timeOfDay: z.number(),
  day: z.number(),
  phase: z.enum(['dawn', 'day', 'dusk', 'night']),
  isRaining: z.boolean(),
  isThundering: z.boolean(),
  lightLevel: z.number(),
  skyLight: z.number(),
  moonPhase: z.number().optional(),
});

export const InventoryStateSchema = z.object({
  items: z.array(ItemStackSchema),
  freeSlots: z.number().int(),
  totalSlots: z.number().int(),
  hotbar: z.array(ItemStackSchema.nullable()),
  selectedHotbarSlot: z.number().int(),
});

export const EntitiesStateSchema = z.object({
  players: z.array(EntityViewSchema),
  hostiles: z.array(EntityViewSchema),
  passives: z.array(EntityViewSchema),
  items: z.array(EntityViewSchema),
  other: z.array(EntityViewSchema),
});

export const BlocksStateSchema = z.object({
  standingOn: z.string(),
  atFeet: z.string(),
  atHead: z.string(),
  facing: BlockViewSchema.nullable(),
  notable: z.array(BlockViewSchema),
  nearbyCounts: z.record(z.string(), z.number()),
});

export const VisionStateSchema = z.object({
  /** Blocks actually in line of sight inside the field of view (honest perception). */
  visible: z.array(BlockViewSchema),
  /** One line per 45° sector: what dominates the horizon in that direction. */
  horizon: z.record(z.string(), z.string()),
  fovDeg: z.number(),
  rays: z.number(),
});

export const CurrentActionSchema = z.object({
  id: z.string(),
  name: z.string(),
  startedAt: z.number(),
}).nullable();

export const ObservationSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION).optional(),
  ts: z.number(),
  tick: z.number(),
  detail: z.enum(['compact', 'full']),
  self: SelfStateSchema,
  world: WorldStateSchema,
  inventory: InventoryStateSchema,
  entities: EntitiesStateSchema,
  blocks: BlocksStateSchema,
  vision: VisionStateSchema.optional(),
  chat: z.array(ChatLineSchema),
  events: z.array(RecentEventSchema),
  action: CurrentActionSchema,
});
export type Observation = z.infer<typeof ObservationSchema>;

// ---------------------------------------------------------------------------------------------
// Actions & skills
// ---------------------------------------------------------------------------------------------
export const ActionRequestSchema = z.object({
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().positive().max(10 * 60_000).optional(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionResultSchema = z.object({
  id: z.string(),
  action: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  startedAt: z.number(),
  finishedAt: z.number(),
  interruptedBy: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const SkillRunRequestSchema = z.object({
  name: z.string().min(1).max(120),
  /** JavaScript source. Must define `async function main(api, args)` (or export it as the last expression). */
  code: z.string().min(1).max(200_000),
  args: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().positive().max(15 * 60_000).default(120_000),
});
export type SkillRunRequest = z.infer<typeof SkillRunRequestSchema>;

export const SkillRunResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  logs: z.array(z.string()),
  /** Every api call the skill made, in order — the mind uses this trace to learn and to debug. */
  trace: z.array(z.object({ t: z.number(), call: z.string(), ok: z.boolean(), ms: z.number(), error: z.string().optional() })),
  startedAt: z.number(),
  finishedAt: z.number(),
  interruptedBy: z.string().optional(),
});
export type SkillRunResult = z.infer<typeof SkillRunResultSchema>;

export const SkillCheckResultSchema = z.object({
  ok: z.boolean(),
  problems: z.array(z.string()),
  apiCalls: z.array(z.string()),
});
export type SkillCheckResult = z.infer<typeof SkillCheckResultSchema>;

// ---------------------------------------------------------------------------------------------
// Reflex configuration — the "spinal cord" parameters the mind can tune at runtime
// ---------------------------------------------------------------------------------------------
export const ReflexConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoEat: z.boolean().default(true),
  eatAtFood: z.number().min(0).max(20).default(14),
  autoDefend: z.boolean().default(true),
  defendRange: z.number().positive().default(6),
  fleeAtHealth: z.number().min(0).max(20).default(7),
  fleeDistance: z.number().positive().default(16),
  avoidCreepers: z.boolean().default(true),
  creeperRange: z.number().positive().default(5),
  surfaceWhenDrowning: z.boolean().default(true),
  drownAtOxygen: z.number().min(0).max(20).default(8),
  escapeLavaAndFire: z.boolean().default(true),
  autoArmor: z.boolean().default(true),
  /** Players the body must never attack even in self-defence. */
  allies: z.array(z.string()).default([]),
});
export type ReflexConfig = z.infer<typeof ReflexConfigSchema>;

// ---------------------------------------------------------------------------------------------
// Requests (mind -> body)
// ---------------------------------------------------------------------------------------------
export const RequestMethodSchema = z.enum([
  'hello',
  'observe',
  'act',
  'skill.run',
  'skill.check',
  'chat',
  'stop',
  'reflex.configure',
  'stream.configure',
  'vision.render',
  'world.region',
  'world.find',
  'actions.manifest',
]);
export type RequestMethod = z.infer<typeof RequestMethodSchema>;

export const StreamConfigSchema = z.object({
  observationHz: z.number().min(0).max(20).default(1),
  detail: z.enum(['compact', 'full']).default('compact'),
});

export const RenderRequestSchema = z.object({
  width: z.number().int().min(8).max(512).default(96),
  height: z.number().int().min(8).max(512).default(54),
  fovDeg: z.number().min(30).max(150).default(90),
  maxDistance: z.number().positive().max(128).default(48),
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const RenderResultSchema = z.object({
  width: z.number().int(),
  height: z.number().int(),
  pngBase64: z.string(),
  /** Hex color -> block name, so a VLM (or a human) can decode the retina image. */
  legend: z.record(z.string(), z.string()),
  /** Natural-language description derived from the same raycast data. */
  description: z.string(),
  source: z.enum(['retina', 'viewer']),
});
export type RenderResult = z.infer<typeof RenderResultSchema>;

export const RegionRequestSchema = z.object({
  min: Vec3Schema,
  max: Vec3Schema,
  /** Skip air blocks in the response (default true). */
  skipAir: z.boolean().default(true),
  maxBlocks: z.number().int().positive().max(200_000).default(50_000),
});

export const FindRequestSchema = z.object({
  names: z.array(z.string()).min(1),
  maxDistance: z.number().positive().max(256).default(64),
  count: z.number().int().positive().max(1000).default(16),
});

export const RequestEnvelopeSchema = z.object({
  kind: z.literal('request'),
  id: z.string().min(1),
  method: RequestMethodSchema,
  params: z.unknown().optional(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;

export const ResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ kind: z.literal('response'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    kind: z.literal('response'),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string(), data: z.unknown().optional() }),
  }),
]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;

export const EventNameSchema = z.enum([
  'ready',
  'observation',
  'chat',
  'whisper',
  'health',
  'hurt',
  'death',
  'respawn',
  'entity.spawn',
  'entity.gone',
  'player.joined',
  'player.left',
  'item.collected',
  'block.broken',
  'block.placed',
  'sleep',
  'wake',
  'daybreak',
  'nightfall',
  'rain',
  'reflex',
  'action.interrupted',
  'kicked',
  'disconnected',
  'error',
]);
export type EventName = z.infer<typeof EventNameSchema>;

export const EventEnvelopeSchema = z.object({
  kind: z.literal('event'),
  event: EventNameSchema,
  ts: z.number(),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const EnvelopeSchema = z.union([RequestEnvelopeSchema, ResponseEnvelopeSchema, EventEnvelopeSchema]);
export type Envelope = z.infer<typeof EnvelopeSchema>;

// ---------------------------------------------------------------------------------------------
// Hello / manifest — lets the mind discover what this body can do
// ---------------------------------------------------------------------------------------------
export const ActionManifestEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  /** JSON schema of the args object (generated from the zod schema of the primitive). */
  params: z.record(z.string(), z.unknown()),
  category: z.enum(['movement', 'mining', 'crafting', 'building', 'combat', 'inventory', 'social', 'perception', 'survival', 'meta']),
  /** Whether the primitive may run for a long time (so the mind should expect streaming progress). */
  longRunning: z.boolean(),
});
export type ActionManifestEntry = z.infer<typeof ActionManifestEntrySchema>;

export const HelloResultSchema = z.object({
  protocol: z.string(),
  body: z.object({ name: z.string(), version: z.string() }),
  minecraft: z.object({ version: z.string(), host: z.string(), port: z.number(), username: z.string() }),
  capabilities: z.object({
    vision: z.enum(['retina', 'viewer', 'none']),
    skills: z.boolean(),
    reflexes: z.boolean(),
  }),
  actions: z.array(ActionManifestEntrySchema),
  skillApiDoc: z.string(),
});
export type HelloResult = z.infer<typeof HelloResultSchema>;

/** Error codes the body emits; the mind maps them to recovery strategies. */
export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  BUSY: 'BUSY',
  TIMEOUT: 'TIMEOUT',
  INTERRUPTED: 'INTERRUPTED',
  NOT_FOUND: 'NOT_FOUND',
  NO_PATH: 'NO_PATH',
  MISSING_ITEM: 'MISSING_ITEM',
  MISSING_TOOL: 'MISSING_TOOL',
  NOT_CONNECTED: 'NOT_CONNECTED',
  SANDBOX_REJECTED: 'SANDBOX_REJECTED',
  SKILL_ERROR: 'SKILL_ERROR',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class BodyError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'BodyError';
  }
}
