// The /v1 middleware: CORS for browser callers, key authentication (`requireKey`) and
// rate limiting with RateLimit-* headers. Routes read the authenticated principal from
// `c.var.principal` and scope every query by it.
import { createHash } from 'node:crypto';

import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';

import { ApiKeyRefusals } from '@backend/domain/apikey/ApiKeyService';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { ApiKeyService, ApiPrincipal } from '@backend/domain/apikey/ApiKeyService';
import type { RateLimiter, RateLimitResult, RateLimitRule } from '@backend/domain/ratelimit/ports';
import type { OtaUploadDeps } from '@backend/transport/ext/v1/ota-uploads';
import type { ApiKeyKind, ApiScope } from '@mocco/common/apikey';
import type { Context } from 'hono';

export interface V1Deps {
  apiKeys: Pick<ApiKeyService, 'authenticate'>;
  limiter: RateLimiter;
  /** OTA uploads from CI; undefined leaves /v1/ota unmounted. */
  ota?: OtaUploadDeps;
}

export interface V1Env {
  Variables: { principal: ApiPrincipal };
}

const BEARER = 'Bearer ';
const KEY_HEADER = 'x-mocco-key';
const ALLOWED_HEADERS = 'authorization, content-type, x-mocco-key, idempotency-key';
const EXPOSED_HEADERS = 'ratelimit-limit, ratelimit-remaining, ratelimit-reset, etag';

/** Per-key limits by kind; per-IP limits for routes without a key. */
export const KeyRateLimits: Record<ApiKeyKind, RateLimitRule> = {
  publishable: { limit: 600, windowSeconds: 60 },
  secret: { limit: 1200, windowSeconds: 60 },
};
export const ANONYMOUS_RATE_LIMIT: RateLimitRule = { limit: 120, windowSeconds: 60 };

/** The key a request presents: `Authorization: Bearer mk_…` or `X-Mocco-Key: mk_…`. */
function presentedKey(c: Context): string | undefined {
  const authorization = c.req.header('authorization') ?? '';
  // eslint-disable-next-line sonarjs/null-dereference -- defaulted to '' above, never null
  if (authorization.startsWith(BEARER)) {
    return authorization.slice(BEARER.length).trim();
  }
  return c.req.header(KEY_HEADER)?.trim();
}

/** The client IP (the first forwarded hop), hashed: buckets never store raw addresses. */
function ipBucketOf(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',', 1)[0]?.trim();
  const ip = forwarded ?? c.req.header('x-real-ip') ?? 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

interface RateLimitHeaders {
  'RateLimit-Limit': string;
  'RateLimit-Remaining': string;
  'RateLimit-Reset': string;
}

function setRateLimitHeaders(c: Context, headers: RateLimitHeaders): void {
  c.header('RateLimit-Limit', headers['RateLimit-Limit']);
  c.header('RateLimit-Remaining', headers['RateLimit-Remaining']);
  c.header('RateLimit-Reset', headers['RateLimit-Reset']);
}

function rateLimitHeaders(rule: RateLimitRule, result: RateLimitResult, now: Date): RateLimitHeaders {
  return {
    'RateLimit-Limit': String(rule.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((result.resetAt.getTime() - now.getTime()) / 1000))),
  };
}

/** Consume one unit from `bucket`; a 429 problem when it's used up, else the headers to add. */
async function limit(deps: V1Deps, bucket: string, rule: RateLimitRule) {
  const result = await deps.limiter.consume(bucket, rule);
  const headers = rateLimitHeaders(rule, result, new Date());
  if (!result.allowed) {
    return {
      refused: problemResponse(problemOf(429, ProblemCodes.rateLimited, 'Too many requests'), {
        ...headers,
        'Retry-After': headers['RateLimit-Reset'],
      }),
      headers,
    };
  }
  return { refused: undefined, headers };
}

/** CORS: answer preflights for any origin (the real request still has to pass the key's
 * origin check), and expose the rate-limit headers. */
export const cors = createMiddleware(async (c, next) => {
  const origin = c.req.header('origin');
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': ALLOWED_HEADERS,
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
  }
  await next();
  c.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  return undefined;
});

/** Per-IP limiting for routes that take no key. */
export const limitAnonymous = (deps: V1Deps) =>
  createMiddleware(async (c, next) => {
    const { refused, headers } = await limit(deps, `ip:${ipBucketOf(c)}:${routePath(c)}`, ANONYMOUS_RATE_LIMIT);
    if (refused !== undefined) {
      return refused;
    }
    await next();
    setRateLimitHeaders(c, headers);
    c.header('Access-Control-Allow-Origin', '*');
    return undefined;
  });

/**
 * Authenticate the request's key, optionally requiring a kind and a scope, then limit
 * per key. Refusals are problem+json: 401 for a missing, unknown, revoked or expired key
 * and for a secret key sent from a browser; 403 for a disallowed origin, kind or scope.
 */
export const requireKey = (deps: V1Deps, opts: { kinds?: readonly ApiKeyKind[]; scope?: ApiScope } = {}) =>
  createMiddleware<V1Env>(async (c, next) => {
    const token = presentedKey(c);
    if (token === undefined || token === '') {
      return problemResponse(problemOf(401, ProblemCodes.missingKey, 'An API key is required'), {
        'WWW-Authenticate': 'Bearer',
      });
    }
    const origin = c.req.header('origin');
    const check = await deps.apiKeys.authenticate(token, { origin });
    if (!check.ok) {
      if (check.refusal === ApiKeyRefusals.originNotAllowed) {
        return problemResponse(
          problemOf(403, ProblemCodes.originNotAllowed, "This origin isn't one of the project's web origins"),
        );
      }
      return check.refusal === ApiKeyRefusals.secretFromBrowser
        ? problemResponse(
            problemOf(401, ProblemCodes.secretKeyFromBrowser, 'Secret keys must not be used from a browser'),
          )
        : problemResponse(problemOf(401, ProblemCodes.invalidKey, 'The API key is invalid, revoked or expired'), {
            'WWW-Authenticate': 'Bearer error="invalid_token"',
          });
    }
    const { principal } = check;
    if (opts.kinds !== undefined && !opts.kinds.includes(principal.kind)) {
      return problemResponse(problemOf(403, ProblemCodes.wrongKeyKind, "This key kind can't call this endpoint"));
    }
    if (opts.scope !== undefined && !principal.scopes.includes(opts.scope)) {
      return problemResponse(problemOf(403, ProblemCodes.insufficientScope, `The key lacks the ${opts.scope} scope`));
    }
    const { refused, headers } = await limit(deps, `key:${principal.keyId}`, KeyRateLimits[principal.kind]);
    if (refused !== undefined) {
      return refused;
    }
    c.set('principal', principal);
    await next();
    setRateLimitHeaders(c, headers);
    if (origin !== undefined) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
    return undefined;
  });
