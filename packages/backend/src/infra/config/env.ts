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
  /** The public API host (ADR 0017), a bare authority such as `api.mocco.club`. Device-facing
   * OTA URLs are built on it when set; also read by next.config.ts for the /v1 rewrite. */
  PUBLIC_API_DOMAIN: z.string().min(1).optional(),
  // Object storage (platform foundations §10). `s3` covers AWS S3, Cloudflare R2, MinIO
  // and Supabase Storage's S3 endpoint; `filesystem` is for dev and single-box
  // self-host. Unset: filesystem locally, and not configured on Vercel.
  STORAGE_DRIVER: z.enum(['s3', 'filesystem']).optional(),
  // Expo push access token, when the Expo project requires one ("enhanced security"); messenger reply push.
  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  // Where help centers are served (also read by next.config.ts): <slug>.<HELP_SITES_DOMAIN>,
  // or a customer domain from HELP_CUSTOM_DOMAINS (`help.example.com=<slug>,…`). /v1 help
  // search builds article URLs from them.
  HELP_SITES_DOMAIN: z.string().min(1).optional(),
  HELP_CUSTOM_DOMAINS: z.string().min(1).optional(),
  // Vercel AI Gateway key for help center translation; unset, help centers serve the source language.
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  // The model help centers translate with (an AI Gateway model id); default anthropic/claude-sonnet-5.
  HELP_TRANSLATION_MODEL: z.string().min(1).optional(),
  STORAGE_BUCKET: z.string().min(1).optional(),
  /** Custom S3 endpoint (R2: `https://<account>.r2.cloudflarestorage.com`); omit for AWS. */
  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().min(1).default('auto'),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** The CDN or public-bucket origin serving the `pub/` prefix, without a trailing slash. */
  STORAGE_PUBLIC_BASE_URL: z.url().optional(),
  /** Filesystem driver: the directory objects live under (default `.mocco-storage` in the cwd). */
  STORAGE_FS_ROOT: z.string().min(1).optional(),
  /** Filesystem driver: the HMAC key of its signed URLs (default: derived from AUTH_SECRET). */
  STORAGE_SIGNING_SECRET: z.string().min(1).optional(),
  // Status page (#150, ADR 0027 §6): a single-node self-hosted server runs the probe loop
  // in-process as the shared `embedded` location. Never on Vercel: the runtime refuses there.
  STATUS_PROBE_EMBEDDED: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform(value => value === 'true' || value === '1'),
  /** How many checks the embedded probe runs at once. */
  STATUS_PROBE_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(20),
});

export type Env = z.infer<typeof schema>;

const state: { env?: Env } = {};

/** Lazy validation — importing this module never throws at build time. */
export function getEnv(): Env {
  state.env ??= schema.parse(process.env);
  return state.env;
}
