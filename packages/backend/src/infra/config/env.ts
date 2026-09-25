import { z } from 'zod';

// Vendor-neutral env names (AUTH_*, not provider-specific). Values are injected
// into the auth provider explicitly — no library reads env on its own.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  /** Session signing secret. Generate with: openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(1).optional(),
  /** Canonical app host — a bare authority, no scheme (prod `www.mocco.club`,
   * local `www.mocco.work`, e2e `localhost:3100`). */
  SERVICE_DOMAIN: z.string().min(1).optional(),
  // Platform-injected (Vercel) — read here so getEnv stays the only process.env
  // reader. Used to derive per-deploy auth origins (see domain/auth/origins.ts).
  VERCEL_ENV: z.string().min(1).optional(),
  VERCEL_URL: z.string().min(1).optional(),
  VERCEL_BRANCH_URL: z.string().min(1).optional(),
  // GitHub App (slice 3a connect/manage). All optional — existing deploys/tests
  // without GitHub configured keep booting; the adapter (domain/integration/github)
  // throws a clear domain error if constructed without them.
  GITHUB_APP_ID: z.string().min(1).optional(),
  /** The App's public slug, used to build the install URL. */
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  /** Base64 of a PKCS#8 PEM private key. Convert once: openssl pkcs8 -topk8 -nocrypt */
  GITHUB_APP_PRIVATE_KEY_B64: z
    .string()
    .min(1)
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) {
        return undefined;
      }
      // Uint8Array.fromBase64/toBase64 are still V8-experimental (behind the
      // --js-base-64 flag, even on current Node) — Buffer is the only base64
      // decoder actually available on the Vercel/Node runtime this targets.
      // eslint-disable-next-line unicorn/prefer-uint8array-base64
      const pem: string = Buffer.from(v, 'base64').toString('utf8');
      // sonarjs/null-dereference is a false positive here: Buffer#toString()
      // always returns a string, never null/undefined.
      // eslint-disable-next-line sonarjs/null-dereference
      if (!pem.includes('BEGIN PRIVATE KEY')) {
        ctx.addIssue({
          code: 'custom',
          message:
            'GITHUB_APP_PRIVATE_KEY_B64 must be a base64 PKCS#8 PEM (convert once: openssl pkcs8 -topk8 -nocrypt)',
        });
        return z.NEVER;
      }
      return pem;
    }),
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  /** Verifies GitHub webhook payload signatures. Optional, same as the other GITHUB_APP_* vars. */
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Job tick (ADR 0014). CRON_SECRET is platform-dictated: Vercel Cron sends it as
  // `Authorization: Bearer <CRON_SECRET>` when the project has it set. JOBS_TICK_SECRET
  // is our alias for self-host callers. With neither set the tick route answers 503.
  CRON_SECRET: z.string().min(1).optional(),
  JOBS_TICK_SECRET: z.string().min(1).optional(),
  /** How long one tick keeps claiming jobs; keep it below the function's max duration. */
  JOBS_TICK_BUDGET_MS: z.coerce.number().int().positive().default(50_000),
  /** SecretBox keys for third-party secrets at rest: `keyId:base64key,…` (first key
   * seals, all open). Generate a key with: openssl rand -base64 32. Optional — only
   * features that store secrets require it, and they fail loudly when it's absent. */
  SECRETS_ENCRYPTION_KEYS: z.string().min(1).optional(),
  // Discord (notification relay design §6). All optional, like the GitHub vars: the
  // bot token alone lets deliveries send; the install flow also needs the client pair.
  // Without them the Discord surfaces answer "not configured".
  /** The Discord application's OAuth2 client id (the bot install). */
  DISCORD_CLIENT_ID: z.string().min(1).optional(),
  DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
  /** The Mocco bot's token; every Discord REST call sends it. */
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  // Stage0 (notification relay design §11, ADR 0020; docs/reference/ops-stage0.md). Both
  // optional; the canary runs only when both are set. The canary is POSTed to this
  // deployment's own SERVICE_DOMAIN, never anywhere else.
  /** The id of the inbound source (kind github) the stage0 canary is sent to. */
  OPS_CANARY_SOURCE_ID: z.uuid().optional(),
  /** The external dead-man switch pinged (GET) when a canary reaches Discord, e.g. a
   * healthchecks.io ping URL. */
  OPS_HEARTBEAT_URL: z.url({ protocol: /^https?$/u }).optional(),
});

export type Env = z.infer<typeof schema>;

const state: { env?: Env } = {};

/** Lazy validation — importing this module never throws at build time. */
export function getEnv(): Env {
  state.env ??= schema.parse(process.env);
  return state.env;
}
