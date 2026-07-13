import { z } from 'zod';

// Vendor-neutral env names (AUTH_*, not provider-specific). Values are injected
// into the auth provider explicitly — no library reads env on its own.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  /** Session signing secret. Generate with: openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(1).optional(),
  /** Canonical public URL of the app (prod `https://www.mocco.club`, local `https://www.mocco.work`). */
  AUTH_URL: z.string().min(1).optional(),
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
});

export type Env = z.infer<typeof schema>;

const state: { env?: Env } = {};

/** Lazy validation — importing this module never throws at build time. */
export function getEnv(): Env {
  state.env ??= schema.parse(process.env);
  return state.env;
}
