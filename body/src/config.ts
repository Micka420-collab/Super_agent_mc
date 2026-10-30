/**
 * Body configuration, parsed once from the environment (and optionally a .env file).
 * Everything has a safe default so `npm run dev` against a local offline-mode server just works.
 */
import { z } from 'zod';

const BoolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const BodyConfigSchema = z.object({
  /** Minecraft server */
  MC_HOST: z.string().default('127.0.0.1'),
  MC_PORT: z.coerce.number().int().positive().default(25565),
  MC_USERNAME: z.string().min(1).default('Emeth'),
  /** 'offline' (cracked / local test server) or 'microsoft' (real account, opens device-code login) */
  MC_AUTH: z.enum(['offline', 'microsoft']).default('offline'),
  /** Leave empty to auto-detect from the server handshake. */
  MC_VERSION: z.string().optional(),
  /** Honest perception: when true, the observation only lists entities/blocks in the bot's field of view. */
  MC_HONEST_PERCEPTION: BoolFromEnv.default(false),
  MC_PERCEPTION_RADIUS: z.coerce.number().positive().default(32),
  MC_FOV_DEG: z.coerce.number().min(30).max(170).default(110),

  /** Bridge (WebSocket server the mind connects to) */
  BRIDGE_HOST: z.string().default('127.0.0.1'),
  BRIDGE_PORT: z.coerce.number().int().positive().default(8765),
  /** Shared secret; the mind sends it as `?token=` or `Authorization: Bearer`. Empty = no auth (local only!). */
  BRIDGE_TOKEN: z.string().default(''),
  BRIDGE_OBSERVATION_HZ: z.coerce.number().min(0).max(20).default(1),

  /** Vision */
  VISION_MODE: z.enum(['retina', 'viewer', 'none']).default('retina'),

  /** Reflexes */
  REFLEX_ENABLED: BoolFromEnv.default(true),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type BodyConfig = z.infer<typeof BodyConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BodyConfig {
  const parsed = BodyConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid body configuration: ${issues}`);
  }
  return parsed.data;
}
