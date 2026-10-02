// /v1/flags (ADR 0024): the compiled ruleset of the flag environment a server SDK's key
// is bound to, and the change stream. Server SDKs evaluate locally and poll the ruleset
// with `If-None-Match`, so the common answer is a 304 that never loads the document.
// Secret keys only for the ruleset: it holds every targeting rule and segment list,
// which must never reach a browser (browsers and apps use OFREP, ofrep.ts).
//
// The stream (`GET /flags/stream`) is an OFREP event stream: `refetchEvaluation` events
// with the snapshot's ETag, `id` = the environment version, so `Last-Event-ID` resumes.
// Until the realtime foundation (#123) lands, each connection checks the environment's
// version once a second (one indexed read) and closes after a few minutes; clients
// reconnect. Authenticated by a key header, or by a stream token (browsers' EventSource
// can't send headers; the OFREP bulk response advertises the tokenized URL).
import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { flagTelemetryInputSchema } from '@mocco/common/flags';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { requireKey } from '@backend/transport/ext/v1/middleware';
import { parseJson, problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { FlagService } from '@backend/domain/flags/FlagService';
import type { FlagTelemetryService } from '@backend/domain/flags/FlagTelemetryService';
import type { StreamTokens } from '@backend/domain/flags/stream-token';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';
import type { Context } from 'hono';

export interface FlagServingDeps {
  flags: Pick<FlagService, 'servingRuleset' | 'ofrepState' | 'rulesetHead'>;
  /** Evaluation counts from SDKs; undefined leaves POST /flags/telemetry unmounted. */
  telemetry?: Pick<FlagTelemetryService, 'ingest'>;
  /** Signs the stream URLs OFREP advertises; undefined: no event streams (clients poll). */
  streamTokens?: StreamTokens;
  /** Stream timing (tests shorten it). */
  stream?: { pollMs?: number; heartbeatMs?: number; maxConnectionMs?: number };
}

const STREAM_POLL_MS = 1000;
const STREAM_HEARTBEAT_MS = 25_000;
/** Vercel caps a function's duration; close first and let the client reconnect. */
const STREAM_MAX_CONNECTION_MS = 240_000;

/** Each SDK instance sends at most one report a minute; this leaves room for many
 * instances sharing a key, and caps what one key can write. */
export const TELEMETRY_RATE_LIMITS = {
  publishable: { limit: 300, windowSeconds: 60 },
  secret: { limit: 300, windowSeconds: 60 },
} as const;

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

  const { telemetry } = flags;
  if (telemetry !== undefined) {
    // Aggregated evaluation counts (#144). Advisory: they feed stale-flag hints only.
    app.post(
      '/telemetry',
      requireKey(deps, {
        scope: ApiScopes.flagsRead,
        routeLimit: { name: 'flags-telemetry', rules: TELEMETRY_RATE_LIMITS },
      }),
      async c => {
        const { workspaceId, flagEnvironmentId, kind } = c.var.principal;
        if (flagEnvironmentId === null) {
          return problemResponse(problemOf(403, ProblemCodes.forbidden, 'This key is not bound to a flag environment'));
        }
        const body = await parseJson(c, flagTelemetryInputSchema);
        if (body.refused !== undefined) {
          return body.refused;
        }
        const result = await telemetry.ingest(
          { workspaceId, environmentId: flagEnvironmentId, keyKind: kind },
          body.data,
        );
        return c.json(result, 202);
      },
    );
  }

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

  /** The change stream for one environment, until it closes (see the header comment). */
  const streamChanges = (c: Context, workspaceId: string, environmentId: string) => {
    const pollMs = flags.stream?.pollMs ?? STREAM_POLL_MS;
    const heartbeatMs = flags.stream?.heartbeatMs ?? STREAM_HEARTBEAT_MS;
    const closesAt = Date.now() + (flags.stream?.maxConnectionMs ?? STREAM_MAX_CONNECTION_MS);
    const lastEventId = Number(c.req.header('last-event-id') ?? NaN);
    c.header('Cache-Control', 'no-cache, no-transform');
    return streamSSE(c, async stream => {
      const head = await flags.flags.rulesetHead(workspaceId, environmentId);
      let seen = Number.isSafeInteger(lastEventId) ? lastEventId : (head?.version ?? 0);
      let quietSince = Date.now();
      await stream.write(`retry: ${String(pollMs * 2)}\n\n`);
      while (!stream.aborted && Date.now() < closesAt) {
        // eslint-disable-next-line no-await-in-loop -- one read per tick, in order
        const current = await flags.flags.rulesetHead(workspaceId, environmentId);
        if (current !== undefined && current.version > seen) {
          seen = current.version;
          quietSince = Date.now();
          // eslint-disable-next-line no-await-in-loop -- events go out in version order
          await stream.writeSSE({
            id: String(current.version),
            event: 'message',
            data: JSON.stringify({ type: 'refetchEvaluation', etag: current.etag }),
          });
        } else if (Date.now() - quietSince >= heartbeatMs) {
          quietSince = Date.now();
          // eslint-disable-next-line no-await-in-loop -- keeps proxies from closing an idle stream
          await stream.write(': ping\n\n');
        }
        // eslint-disable-next-line no-await-in-loop -- the stream's pacing
        await stream.sleep(pollMs);
      }
    });
  };

  // A key header (server SDKs) or a stream token in the URL (browsers' EventSource).
  app.get('/stream', async (c, next) => {
    const token = c.req.query('token');
    if (token === undefined) {
      return await requireKey(deps, { scope: ApiScopes.flagsRead })(c, next);
    }
    const scope = flags.streamTokens?.verify(token);
    if (scope === undefined || scope === null) {
      return problemResponse(problemOf(401, ProblemCodes.invalidKey, 'The stream token is invalid or expired'));
    }
    // The token is the credential, and it names one environment: any origin may listen.
    c.header('Access-Control-Allow-Origin', '*');
    return streamChanges(c, scope.workspaceId, scope.environmentId);
  });
  app.get('/stream', async c => {
    const { workspaceId, flagEnvironmentId } = c.var.principal;
    if (flagEnvironmentId === null) {
      return problemResponse(problemOf(403, ProblemCodes.forbidden, 'This key is not bound to a flag environment'));
    }
    return streamChanges(c, workspaceId, flagEnvironmentId);
  });

  return app;
}
