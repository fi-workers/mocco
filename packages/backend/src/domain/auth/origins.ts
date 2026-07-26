// Environment-aware auth origins — a pure, side-effect-free resolution so it is
// unit-tested without a server. better-auth needs a baseURL (to build links) and
// trustedOrigins (to accept requests), and both differ per deploy environment:
// production has a stable custom domain, every preview deploy has its own Vercel
// URL, local mirrors production. The composition root reads env (getEnv) and
// passes the values in — this stays vendor-neutral.

export interface AuthOriginEnv {
  /** Our canonical production/local host — a bare authority (`host` or `host:port`,
   * no scheme), e.g. `www.mocco.club` or `localhost:3100` (SERVICE_DOMAIN). */
  serviceDomain?: string;
  /** Vercel-injected: 'production' | 'preview' | 'development'. */
  vercelEnv?: string;
  /** Vercel-injected: this deployment's own URL (no scheme). */
  vercelUrl?: string;
  /** Vercel-injected: the stable per-branch alias URL (no scheme). */
  vercelBranchUrl?: string;
}

export interface AuthOrigins {
  /** baseURL for the provider; undefined lets the vendor infer from headers. */
  baseUrl?: string;
  /** Origins allowed to call the auth endpoints. */
  trustedOrigins: string[];
}

/** `[origin, www-toggled origin]` — apex and www are trusted together, since both
 * prod and local redirect between them (apex ⇄ www). */
function originVariants(raw: string): string[] {
  const url = new URL(raw);
  const toggledHost = url.host.startsWith('www.') ? url.host.slice(4) : `www.${url.host}`;
  return [url.origin, `${url.protocol}//${toggledHost}`];
}

/** SERVICE_DOMAIN carries no scheme — derive it from the host. Loopback hosts
 * (local dev, e2e) are plain http; everything else (real domains, Vercel-style
 * hosts) is https. */
function schemeFor(host: string): 'http' | 'https' {
  // Parse via URL (with a throwaway scheme) instead of splitting on ':' by hand —
  // that stays correct for bracketed IPv6 authorities too (e.g. `[::1]:3100`).
  const url = new URL(`http://${host}`);
  const isLoopback = url.hostname === 'localhost' || url.hostname.startsWith('127.') || url.hostname === '[::1]';
  return isLoopback ? 'http' : 'https';
}

export function resolveAuthOrigins(env: AuthOriginEnv): AuthOrigins {
  // Preview: trust ONLY this deployment's own Vercel URLs. Never a `*.vercel.app`
  // wildcard — that trusts every Vercel-hosted site. SERVICE_DOMAIN is ignored here.
  if (env.vercelEnv === 'preview') {
    const urls = [env.vercelUrl, env.vercelBranchUrl]
      .filter((host): host is string => Boolean(host))
      .map(host => `https://${host}`);
    return { baseUrl: urls.at(-1), trustedOrigins: urls };
  }
  // Production and local development: the canonical SERVICE_DOMAIN (scheme derived)
  // plus its www/apex twin.
  if (env.serviceDomain) {
    const url = `${schemeFor(env.serviceDomain)}://${env.serviceDomain}`;
    return { baseUrl: new URL(url).origin, trustedOrigins: originVariants(url) };
  }
  return { trustedOrigins: [] };
}
