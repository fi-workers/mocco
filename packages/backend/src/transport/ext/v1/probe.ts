// /v1/probe (#150, ADR 0027): the protocol `@mocco/probe` agents speak. Not an API key: the
// bearer is a location token, and every call acts as that location. A request without a valid
// token for an enabled location is 401 before anything is read. The routes only parse and
// delegate; what a location may lease and report is decided in ProbeService.
import { probeHeartbeatRequestSchema, probeLeaseRequestSchema, probeResultsRequestSchema } from '@mocco/common/status';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { limit } from '@backend/transport/ext/v1/middleware';
import { parseJson, problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { RateLimitRule } from '@backend/domain/ratelimit/ports';
import type { ProbeLocation, ProbeService } from '@backend/domain/status/ProbeService';
import type { V1Deps } from '@backend/transport/ext/v1/middleware';

export interface ProbeProtocolDeps {
  probes: Pick<ProbeService, 'authenticate' | 'lease' | 'report' | 'heartbeat'>;
}

interface ProbeEnv {
  Variables: { location: ProbeLocation };
}

const BEARER = 'Bearer ';
/** Per location: an agent polls a few times a minute and reports in batches. */
const PROBE_RATE_LIMIT: RateLimitRule = { limit: 600, windowSeconds: 60 };

const requireLocation = (deps: V1Deps, probe: ProbeProtocolDeps) =>
  createMiddleware<ProbeEnv>(async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';

    const token = authorization.startsWith(BEARER) ? authorization.slice(BEARER.length).trim() : '';
    const location = token === '' ? undefined : await probe.probes.authenticate(token);
    if (location === undefined) {
      return problemResponse(
        problemOf(401, ProblemCodes.invalidLocationToken, 'The location token is invalid or the location is disabled'),
        { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      );
    }
    const { refused } = await limit(deps, `probe:${location.id}`, PROBE_RATE_LIMIT);
    if (refused !== undefined) {
      return refused;
    }
    c.set('location', location);
    await next();
    return undefined;
  });

export function createProbeRoutes(deps: V1Deps, probe: ProbeProtocolDeps): Hono<ProbeEnv> {
  const app = new Hono<ProbeEnv>();
  app.use('*', requireLocation(deps, probe));

  // The rounds due at this location in the next minute, each with its spec and lease id.
  app.post('/lease', async c => {
    const { data, refused } = await parseJson(c, probeLeaseRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    return c.json(await probe.probes.lease(c.var.location, data));
  });

  // One result per lease; results that match no outstanding lease of this location are refused.
  app.post('/results', async c => {
    const { data, refused } = await parseJson(c, probeResultsRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    return c.json(await probe.probes.report(c.var.location, data.results), 202);
  });

  app.post('/heartbeat', async c => {
    const { data, refused } = await parseJson(c, probeHeartbeatRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    await probe.probes.heartbeat(c.var.location, data);
    return c.body(null, 204);
  });

  return app;
}
