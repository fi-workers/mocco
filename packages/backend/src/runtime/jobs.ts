// Top-level composition root for the job runner (ADR 0014). It sits above the domains,
// like transport: it imports each domain's pure handler factory (`domain/<x>/jobs.ts`,
// which never imports its own instance.ts) and builds one registry. Domains that only
// enqueue use `getJobQueue()` from domain/jobs/instance.ts, which reaches this module
// lazily (dynamic import) for `kick`, so no instance.ts ever imports another domain's
// instance.ts through the job registry. For the same reason this file builds its own
// event bus with the pure `createEventBus` instead of importing events/instance.ts.
import { randomUUID } from 'node:crypto';

import { waitUntil } from '@vercel/functions';

import { createEventHandlers, pruneEventsSchedule } from '@backend/domain/events/jobs';
import { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { JobHandlerRegistry, type JobHandler } from '@backend/domain/jobs/handlers';
import { JobRunner } from '@backend/domain/jobs/JobRunner';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { createPruneHandlers, pruneSchedule } from '@backend/domain/jobs/prune';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { createDiscordApiFromEnv } from '@backend/domain/notification/discord-config';
import { createNotificationHandlers, notificationSchedules } from '@backend/domain/notification/jobs';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { DiscordMessenger } from '@backend/domain/notification/DeliveryService';
import type { Db } from '@backend/infra/db/types';

/** Upper bound on jobs one tick runs; the time budget usually stops it first. */
export const DEFAULT_TICK_MAX_JOBS = 100;

export interface JobRunnerRuntimeDeps {
  now: () => Date;
  random: () => number;
  workerId: string;
  /** Keeps a job kicked from inside a handler alive (e.g. a subscriber that publishes). */
  waitUntil: (promise: Promise<unknown>) => void;
  /** The app's origin, for links in notification messages. */
  appOrigin: string;
  /** The Discord client deliveries send with; undefined without DISCORD_BOT_TOKEN. */
  discord: DiscordMessenger | undefined;
}

/** Build the runner with every domain's handlers over a db. Production binds it once
 * below; tests call it with a pglite db and a fake clock. */
export function createJobRunner(db: Db, deps: JobRunnerRuntimeDeps): JobRunner {
  const jobs = new JobRepo(db);
  // Handlers enqueue through a queue whose kicks run on this same runner.
  const self: { runner?: JobRunner } = {};
  const queue = new PostgresJobQueue({
    jobs,
    now: deps.now,
    runOne: async id => await self.runner?.runOne(id),
    waitUntil: deps.waitUntil,
  });
  // Add each domain's handler factory here: `...createXHandlers({ …repos/services })`.
  const handlers: JobHandler[] = [
    ...createPruneHandlers(jobs),
    ...createEventHandlers({
      bus: createEventBus({ db, queue, now: deps.now, appOrigin: deps.appOrigin }),
      events: new DomainEventRepo(db),
    }),
    ...createNotificationHandlers({
      deliveries: new DeliveryRepo(db),
      channels: new ChannelRepo(db),
      rateLimits: new DiscordRateLimitRepo(db),
      discord: deps.discord,
      random: deps.random,
    }),
  ];
  self.runner = new JobRunner({
    jobs,
    schedules: new JobScheduleRepo(db, jobs),
    handlers: new JobHandlerRegistry(handlers),
    now: deps.now,
    random: deps.random,
    workerId: deps.workerId,
    systemSchedules: [pruneSchedule, pruneEventsSchedule, ...notificationSchedules],
  });
  return self.runner;
}

const state: { runner?: JobRunner } = {};

/** The production job runner (lazy). Used by the tick route and by `kick`. */
export function getJobRunner(): JobRunner {
  if (!state.runner) {
    const env = getEnv();
    const now = () => new Date();
    state.runner = createJobRunner(getDb(), {
      now,
      random: Math.random,
      workerId: `fn-${randomUUID().slice(0, 8)}`,
      waitUntil,
      appOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
      discord: createDiscordApiFromEnv(env, { fetch, now }),
    });
  }
  return state.runner;
}
