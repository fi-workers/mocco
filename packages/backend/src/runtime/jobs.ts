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
import { InboundService } from '@backend/domain/inbound/InboundService';
import { createInboundHandlers, inboundSchedules } from '@backend/domain/inbound/jobs';
import { InboundReceiptRepo } from '@backend/domain/inbound/repos/inbound-receipt.repo';
import { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import { JobHandlerRegistry, type JobHandler } from '@backend/domain/jobs/handlers';
import { JobRunner } from '@backend/domain/jobs/JobRunner';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { createPruneHandlers, pruneSchedule } from '@backend/domain/jobs/prune';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { getSecretBox } from '@backend/infra/crypto/instance';
import { getDb } from '@backend/infra/db/client';

import type { Db } from '@backend/infra/db/types';

/** Upper bound on jobs one tick runs; the time budget usually stops it first. */
export const DEFAULT_TICK_MAX_JOBS = 100;

export interface JobRunnerRuntimeDeps {
  now: () => Date;
  random: () => number;
  workerId: string;
  /** Keeps a job kicked from inside a handler alive (e.g. a subscriber that publishes). */
  waitUntil: (promise: Promise<unknown>) => void;
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
  const bus = createEventBus({ db, queue, now: deps.now });
  // The inbound jobs (republish, prune) never open a secret; the box is resolved only
  // if one is opened, so a deploy without SECRETS_ENCRYPTION_KEYS still builds the runner.
  const inbound = new InboundService({
    sources: new InboundSourceRepo(db),
    receipts: new InboundReceiptRepo(db),
    box: { open: (sealed, aad) => getSecretBox().open(sealed, aad) },
    bus,
    now: deps.now,
  });
  // Add each domain's handler factory here: `...createXHandlers({ …repos/services })`.
  const handlers: JobHandler[] = [
    ...createPruneHandlers(jobs),
    ...createEventHandlers({ bus, events: new DomainEventRepo(db) }),
    ...createInboundHandlers({ inbound }),
  ];
  self.runner = new JobRunner({
    jobs,
    schedules: new JobScheduleRepo(db, jobs),
    handlers: new JobHandlerRegistry(handlers),
    now: deps.now,
    random: deps.random,
    workerId: deps.workerId,
    systemSchedules: [pruneSchedule, pruneEventsSchedule, ...inboundSchedules],
  });
  return self.runner;
}

const state: { runner?: JobRunner } = {};

/** The production job runner (lazy). Used by the tick route and by `kick`. */
export function getJobRunner(): JobRunner {
  state.runner ??= createJobRunner(getDb(), {
    now: () => new Date(),
    random: Math.random,
    workerId: `fn-${randomUUID().slice(0, 8)}`,
    waitUntil,
  });
  return state.runner;
}
