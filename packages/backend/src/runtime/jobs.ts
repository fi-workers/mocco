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
import { createDiscordApiFromEnv } from '@backend/domain/notification/discord-config';
import { createNotificationHandlers, notificationSchedules } from '@backend/domain/notification/jobs';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { DiscordConnectStateRepo } from '@backend/domain/notification/repos/discord-connect-state.repo';
import { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import { stage0CanaryMatcher } from '@backend/domain/ops/canary';
import { stage0ConfigFromEnv } from '@backend/domain/ops/config';
import { createOpsHandlers, opsSchedules } from '@backend/domain/ops/jobs';
import { OpsCanaryRepo } from '@backend/domain/ops/repos/ops-canary.repo';
import { Stage0Service, type Stage0Discord, type Stage0Runtime } from '@backend/domain/ops/Stage0Service';
import { getEnv } from '@backend/infra/config/env';
import { getSecretBox } from '@backend/infra/crypto/instance';
import { getDb } from '@backend/infra/db/client';

import type { DiscordMessenger } from '@backend/domain/notification/DeliveryService';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
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
  /** The Discord client deliveries send with (and the canary deletes with); undefined
   * without DISCORD_BOT_TOKEN. */
  discord: (DiscordMessenger & Stage0Discord) | undefined;
  /** Opens sealed secrets (the canary source's). Production resolves the SecretBox
   * lazily, so a deploy without SECRETS_ENCRYPTION_KEYS still builds the runner. */
  box: Pick<SecretBox, 'open'>;
  /** The stage0 canary and heartbeat (docs/reference/ops-stage0.md); undefined when
   * OPS_CANARY_SOURCE_ID / OPS_HEARTBEAT_URL are not both set. */
  stage0?: Stage0Runtime;
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
  const { stage0: stage0Runtime } = deps;
  const bus = createEventBus({
    db,
    queue,
    now: deps.now,
    appOrigin: deps.appOrigin,
    isCanary: stage0Runtime === undefined ? undefined : stage0CanaryMatcher(stage0Runtime.config.canarySourceId),
  });
  const { box } = deps;
  const sources = new InboundSourceRepo(db);
  const inbound = new InboundService({
    sources,
    receipts: new InboundReceiptRepo(db),
    box,
    bus,
    now: deps.now,
  });
  const stage0 = new Stage0Service({
    stage0: stage0Runtime,
    sources,
    box,
    canaries: new OpsCanaryRepo(db),
    discord: deps.discord,
  });
  // Add each domain's handler factory here: `...createXHandlers({ …repos/services })`.
  const handlers: JobHandler[] = [
    ...createPruneHandlers(jobs),
    ...createEventHandlers({ bus, events: new DomainEventRepo(db) }),
    ...createInboundHandlers({ inbound }),
    ...createNotificationHandlers({
      deliveries: new DeliveryRepo(db),
      channels: new ChannelRepo(db),
      rateLimits: new DiscordRateLimitRepo(db),
      discord: deps.discord,
      random: deps.random,
      connectStates: new DiscordConnectStateRepo(db),
      // A sent canary deletes its message and pings the heartbeat (stage0).
      onSent: stage0Runtime === undefined ? undefined : async sent => await stage0.onDelivered(sent),
    }),
    ...createOpsHandlers({ stage0 }),
  ];
  self.runner = new JobRunner({
    jobs,
    schedules: new JobScheduleRepo(db, jobs),
    handlers: new JobHandlerRegistry(handlers),
    now: deps.now,
    random: deps.random,
    workerId: deps.workerId,
    systemSchedules: [
      pruneSchedule,
      pruneEventsSchedule,
      ...notificationSchedules,
      ...inboundSchedules,
      ...opsSchedules(stage0Runtime !== undefined),
    ],
  });
  return self.runner;
}

const state: { runner?: JobRunner } = {};

/** The production job runner (lazy). Used by the tick route and by `kick`. */
export function getJobRunner(): JobRunner {
  if (!state.runner) {
    const env = getEnv();
    const now = () => new Date();
    const stage0Config = stage0ConfigFromEnv(env);
    state.runner = createJobRunner(getDb(), {
      now,
      random: Math.random,
      workerId: `fn-${randomUUID().slice(0, 8)}`,
      waitUntil,
      appOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
      discord: createDiscordApiFromEnv(env, { fetch, now }),
      // The inbound jobs (republish, prune) never open a secret; the box is resolved only
      // if one is opened (the stage0 canary), so a deploy without SECRETS_ENCRYPTION_KEYS
      // still builds the runner.
      box: { open: (sealed, aad) => getSecretBox().open(sealed, aad) },
      stage0: stage0Config === undefined ? undefined : { config: stage0Config, fetch },
    });
  }
  return state.runner;
}
