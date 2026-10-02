// The rate limiter's job handlers, as pure factories. runtime/jobs.ts registers them.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { SystemSchedule } from '@backend/domain/jobs/repos/job-schedule.repo';
import type { RateLimitCounterRepo } from '@backend/domain/ratelimit/repos/rate-limit-counter.repo';

export const RateLimitJobKinds = {
  prune: 'ratelimit.prune',
} as const;

/** Counters are only needed for the window they count; keep a day for debugging. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

export const pruneRateLimitCounters = defineJob(RateLimitJobKinds.prune, z.object({}));

/** Hourly, as a platform schedule ensured by every tick. */
export const rateLimitPruneSchedule: SystemSchedule = {
  kind: RateLimitJobKinds.prune,
  payload: {},
  intervalSeconds: 60 * 60,
};

export function createRateLimitHandlers(deps: { counters: RateLimitCounterRepo }): JobHandler[] {
  return [
    handleJob(pruneRateLimitCounters, async (_payload, ctx) => {
      await deps.counters.prune(new Date(ctx.now().getTime() - RETENTION_MS));
    }),
  ];
}
