// OFREP (OpenFeature Remote Evaluation Protocol, ADR 0024 §3), mounted at
// /v1/ofrep/v1/…, so an OFREP provider's base URL is Mocco's public API base
// (`https://api.mocco.club/v1`). Any `flags:read` key: a publishable key (browsers and
// apps) sees only client-visible flags; a secret key sees all. Responses carry resolved
// values only — never rules, segment lists or Mocco's flag metadata.
import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { Hono } from 'hono';

import { ofrepBulk, ofrepContextOf, ofrepEtag, ofrepResult } from '@backend/domain/flags/ofrep';
import { requireKey } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { FlagServingDeps } from '@backend/transport/ext/v1/flags';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';
import type { Context } from 'hono';

/** Seconds of inactivity after which an OFREP provider should drop the stream. */
const INACTIVITY_DELAY_SEC = 120;

async function bodyOf(c: Context): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    return null;
  }
}

const invalidContext = (c: Context, key?: string) =>
  c.json(
    {
      ...(key !== undefined && { key }),
      errorCode: 'INVALID_CONTEXT',
      errorDetails: 'The body must be a JSON object with an object `context`',
    },
    400,
  );

/** The stream URL a bulk response advertises (OFREP eventStreams), next to this route. */
function streamUrl(c: Context, token: string): string {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/\/ofrep\/v1\/evaluate\/flags$/u, '/flags/stream');
  url.search = new URLSearchParams({ token }).toString();
  return url.href;
}

export function createOfrepRoutes(deps: V1Deps, flags: FlagServingDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();
  const keyed = requireKey(deps, { scope: ApiScopes.flagsRead });

  /** The key's environment state, or a problem response. */
  const stateOf = async (c: Context<V1Env>) => {
    const { workspaceId, flagEnvironmentId, kind } = c.var.principal;
    if (flagEnvironmentId === null) {
      return {
        problem: problemResponse(problemOf(403, ProblemCodes.forbidden, 'This key is not bound to a flag environment')),
      };
    }
    const state = await flags.flags.ofrepState(workspaceId, flagEnvironmentId);
    if (state === undefined) {
      return {
        problem: problemResponse(problemOf(404, ProblemCodes.notFound, 'The flag environment no longer exists')),
      };
    }
    const isClient = kind === ApiKeyKinds.publishable;
    const isVisible = (key: string) => !isClient || state.clientVisible.has(key);
    return { state, isVisible, isClient, workspaceId, environmentId: flagEnvironmentId };
  };

  app.post('/evaluate/flags', keyed, async c => {
    const scope = await stateOf(c);
    if ('problem' in scope) {
      return scope.problem;
    }
    const context = ofrepContextOf(await bodyOf(c));
    if (context === null) {
      return c.json(
        { errorCode: 'INVALID_CONTEXT', errorDetails: 'The body must be a JSON object with an object `context`' },
        400,
      );
    }
    const etag = ofrepEtag(scope.state.etag, scope.isClient ? 'client' : 'server', context);
    const headers = { ETag: etag, 'Cache-Control': 'private, no-cache' };
    const held = (c.req.header('if-none-match') ?? '')
      .split(',')
      // eslint-disable-next-line sonarjs/null-dereference -- split() yields strings
      .map(tag => tag.trim().replace(/^W\//u, ''));
    if (held.includes(etag)) {
      return c.body(null, 304, headers);
    }
    const token = flags.streamTokens?.issue(scope.workspaceId, scope.environmentId);
    return c.json(
      {
        flags: ofrepBulk(scope.state.ruleset, scope.isVisible, context),
        metadata: { version: scope.state.version },
        ...(token !== undefined && {
          eventStreams: [{ type: 'sse', url: streamUrl(c, token), inactivityDelaySec: INACTIVITY_DELAY_SEC }],
        }),
      },
      200,
      headers,
    );
  });

  app.post('/evaluate/flags/:key', keyed, async c => {
    const key = c.req.param('key');
    const scope = await stateOf(c);
    if ('problem' in scope) {
      return scope.problem;
    }
    const context = ofrepContextOf(await bodyOf(c));
    if (context === null) {
      return invalidContext(c, key);
    }
    // A flag the key may not see is indistinguishable from one that doesn't exist.
    const result = scope.isVisible(key)
      ? ofrepResult(scope.state.ruleset, key, context)
      : { key, errorCode: 'FLAG_NOT_FOUND' as const, errorDetails: `Flag "${key}" was not found` };
    if ('errorCode' in result) {
      return c.json(result, result.errorCode === 'FLAG_NOT_FOUND' ? 404 : 400);
    }
    return c.json(result, 200, { 'Cache-Control': 'private, no-cache' });
  });

  return app;
}
