// The job tick route (ADR 0014), mounted on the ext app under /api/ext. Vercel Cron
// calls it with GET and `Authorization: Bearer <CRON_SECRET>`; self-host crons and
// curl may use GET or POST with either secret. A thin adapter over JobRunner.tick.
import { createHash, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import type { JobRunner } from '@backend/domain/jobs/JobRunner';

export const JOB_TICK_PATH = '/internal/jobs/tick';

export interface JobTickDeps {
  runner: Pick<JobRunner, 'tick'>;
  /** Accepted bearer secrets (`CRON_SECRET`, `JOBS_TICK_SECRET`); empty → the route 503s. */
  secrets: readonly string[];
  budgetMs: number;
  maxJobs: number;
}

const BEARER_SCHEME = 'Bearer';
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time check of `Authorization: Bearer <secret>` against any accepted secret
 * (comparing digests keeps the comparison length-independent). */
function isAuthorized(header: string | undefined, secrets: readonly string[]): boolean {
  const parts = (header ?? '').split(' ');
  const [scheme, token] = parts;
  if (parts.length !== 2 || scheme !== BEARER_SCHEME || token === undefined) {
    return false;
  }
  const presented = digest(token);
  return secrets.some(secret => timingSafeEqual(presented, digest(secret)));
}

/** `tick` undefined (no secret configured) → every call 503s. */
export function createJobTickRoutes(tick: JobTickDeps | undefined): Hono {
  const app = new Hono();
  app.on(['GET', 'POST'], JOB_TICK_PATH, async c => {
    if (!tick || tick.secrets.length === 0) {
      return c.text('job tick is not configured', 503);
    }
    if (!isAuthorized(c.req.header('authorization'), tick.secrets)) {
      return c.text('unauthorized', 401);
    }
    const report = await tick.runner.tick({ budgetMs: tick.budgetMs, maxJobs: tick.maxJobs });
    return c.json(report, 200);
  });
  return app;
}
