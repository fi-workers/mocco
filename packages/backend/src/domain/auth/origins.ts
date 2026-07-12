// Environment-aware auth origins — a pure, side-effect-free resolution so it is
// unit-tested without a server. better-auth needs a baseURL (to build links) and
// trustedOrigins (to accept requests), and both differ per deploy environment:
// production has a stable custom domain, every preview deploy has its own Vercel
// URL, local mirrors production. The composition root reads env (getEnv) and
// passes the values in — this stays vendor-neutral.

export interface AuthOriginEnv {
  /** Our canonical production/local URL (AUTH_URL). */
  authUrl?: string;
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

export function resolveAuthOrigins(env: AuthOriginEnv): AuthOrigins {
  // Preview: trust ONLY this deployment's own Vercel URLs. Never a `*.vercel.app`
  // wildcard — that trusts every Vercel-hosted site. AUTH_URL is ignored here.
  if (env.vercelEnv === 'preview') {
    const urls = [env.vercelUrl, env.vercelBranchUrl]
      .filter((host): host is string => Boolean(host))
      .map(host => `https://${host}`);
    return { baseUrl: urls.at(-1), trustedOrigins: urls };
  }
  // Production and local development: the canonical AUTH_URL plus its www/apex twin.
  if (env.authUrl) {
    return { baseUrl: new URL(env.authUrl).origin, trustedOrigins: originVariants(env.authUrl) };
  }
  return { trustedOrigins: [] };
}
