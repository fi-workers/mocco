// /v1/flags (ADR 0024): the compiled ruleset of the flag environment a server SDK's key
// is bound to. Server SDKs evaluate locally and poll this with `If-None-Match`, so the
// common answer is a 304 that never loads the document. Secret keys only: a ruleset
// holds every targeting rule and segment list, which must never reach a browser.
import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { Hono } from 'hono';

import { requireKey } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { FlagService } from '@backend/domain/flags/FlagService';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';

export interface FlagServingDeps {
  flags: Pick<FlagService, 'servingRuleset'>;
}

/** Revalidate on every use; never stored by a shared cache. */
const CACHE_CONTROL = 'private, no-cache';

/** The entity tags an `If-None-Match` header lists (weak or strong; `*` matches any). */
const heldEtags = (header: string | undefined): string[] =>
  (header ?? '')
    .split(',')
    // eslint-disable-next-line sonarjs/null-dereference -- split() yields strings, never null
    .map(tag => tag.trim().replace(/^W\//u, ''))
    .filter(tag => tag !== '');

export function createFlagServingRoutes(deps: V1Deps, flags: FlagServingDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();

  app.get('/ruleset', requireKey(deps, { kinds: [ApiKeyKinds.secret], scope: ApiScopes.flagsRead }), async c => {
    const { workspaceId, flagEnvironmentId } = c.var.principal;
    if (flagEnvironmentId === null) {
      // The DB ties flags:read to an environment; this is a guard, not a code path.
      return problemResponse(problemOf(403, ProblemCodes.forbidden, 'This key is not bound to a flag environment'));
    }
    const held = heldEtags(c.req.header('if-none-match'));
    const ruleset = await flags.flags.servingRuleset(workspaceId, flagEnvironmentId, held);
    if (ruleset === undefined) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'The flag environment no longer exists'));
    }
    const headers = { ETag: ruleset.etag, 'Cache-Control': CACHE_CONTROL };
    if (ruleset.document === undefined || held.includes('*')) {
      return c.body(null, 304, headers);
    }
    return c.json(ruleset.document, 200, headers);
  });

  return app;
}
