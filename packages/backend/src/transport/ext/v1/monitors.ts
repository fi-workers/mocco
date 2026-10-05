// /v1/monitors (#155): a pipeline step asks for an ad-hoc round of one of its project's monitors,
// e.g. right after a deploy, instead of waiting for the next scheduled one. A secret key with
// `status:write`, of the project that owns the monitor; another project's monitor is 404. The
// route only parses and maps errors: MonitorService.requestCheck decides.
import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { Hono } from 'hono';
import { z } from 'zod';

import { ConflictError, NotFoundError } from '@backend/domain/errors';
import { requireKey } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { RateLimitRule } from '@backend/domain/ratelimit/ports';
import type { MonitorService } from '@backend/domain/status/MonitorService';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';

export interface MonitorCheckDeps {
  monitors: Pick<MonitorService, 'requestCheck'>;
}

/** Per key, on top of the key's own limit: a pipeline checks after a deploy, not in a loop. */
export const MONITOR_CHECK_RATE_LIMIT: RateLimitRule = { limit: 10, windowSeconds: 60 };

const monitorIdSchema = z.uuid();

const notFound = () => problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found', 'No such monitor'));

export function createMonitorCheckRoutes(deps: V1Deps, monitors: MonitorCheckDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();

  // Run the monitor's next round now. 202: the round is due; its verdict follows when the
  // probes report, like any round.
  app.post(
    '/:monitorId/check',
    requireKey(deps, {
      scope: ApiScopes.statusWrite,
      kinds: [ApiKeyKinds.secret],
      routeLimit: {
        name: 'monitor-check',
        rules: { publishable: MONITOR_CHECK_RATE_LIMIT, secret: MONITOR_CHECK_RATE_LIMIT },
      },
    }),
    async c => {
      const monitorId = monitorIdSchema.safeParse(c.req.param('monitorId'));
      if (!monitorId.success) {
        return notFound();
      }
      const { workspaceId, projectId } = c.var.principal;
      try {
        const round = await monitors.monitors.requestCheck({ workspaceId, projectId }, monitorId.data);
        return c.json({ monitorId: round.monitorId, roundAt: round.roundAt.toISOString() }, 202);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return notFound();
        }
        if (error instanceof ConflictError) {
          return problemResponse(problemOf(409, ProblemCodes.conflict, 'Conflict', error.message));
        }
        throw error;
      }
    },
  );

  return app;
}
