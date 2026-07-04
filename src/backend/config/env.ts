import { z } from 'zod';

// Vendor-neutral env names (AUTH_*, not provider-specific). Values are injected
// into the auth provider explicitly — no library reads env on its own.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  /** Session signing secret. Generate with: openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(1).optional(),
  /** Public base URL of the app (e.g. https://mocco.work). */
  AUTH_URL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

const state: { env?: Env } = {};

/** Lazy validation — importing this module never throws at build time. */
export function getEnv(): Env {
  state.env ??= schema.parse(process.env);
  return state.env;
}
