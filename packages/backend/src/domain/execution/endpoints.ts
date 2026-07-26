// Pure derivation of the execution loop's absolute endpoints from the app's own
// origin — side-effect-free so it is unit-tested without a server (mirrors
// domain/auth/origins.ts). The composition root reads env (getEnv) and passes the
// bare host in; the callback/executor URLs are injected as strings into the
// services so tests need no env.

const CALLBACK_PATH = '/api/ext/callback';
const GENERIC_EXECUTOR_PATH = '/api/ext/executor/generic';

/** A bare authority (SERVICE_DOMAIN) carries no scheme — derive it. Loopback hosts
 * (local dev, e2e) are plain http; everything else (real domains, Vercel hosts) is
 * https. Parsed via URL so bracketed IPv6 authorities stay correct. */
function schemeFor(host: string): 'http' | 'https' {
  const url = new URL(`http://${host}`);
  const isLoopback = url.hostname === 'localhost' || url.hostname.startsWith('127.') || url.hostname === '[::1]';
  return isLoopback ? 'http' : 'https';
}

export interface EndpointEnv {
  /** SERVICE_DOMAIN — our canonical host, a bare authority (no scheme). */
  serviceDomain?: string;
  /** Vercel-injected: this deployment's own URL (no scheme). The callback must loop
   * back to THIS deployment, so a preview (no SERVICE_DOMAIN) falls back to it. */
  vercelUrl?: string;
}

/** The app's own origin (`scheme://host`). Prefers SERVICE_DOMAIN, falls back to the
 * per-deploy Vercel URL, then to the e2e loopback so a bare boot never throws. */
export function resolveBaseOrigin(env: EndpointEnv): string {
  const host = env.serviceDomain ?? env.vercelUrl ?? 'localhost:3100';
  return `${schemeFor(host)}://${host}`;
}

/** Absolute `/api/ext/callback` URL executors POST progress to. */
export function callbackUrlFrom(baseOrigin: string): string {
  return `${baseOrigin}${CALLBACK_PATH}`;
}

/** Absolute `/api/ext/executor/generic` URL the generic executor's trigger targets. */
export function genericExecutorUrlFrom(baseOrigin: string): string {
  return `${baseOrigin}${GENERIC_EXECUTOR_PATH}`;
}
