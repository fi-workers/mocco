import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DomainEventTypes } from '@mocco/common/events';
import { JobStatuses } from '@mocco/common/jobs';
import { DeliveryStatuses } from '@mocco/common/notification';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { EventJobKinds } from '@backend/domain/events/EventBus';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { FlagJobKinds } from '@backend/domain/flags/jobs';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { HelpIndexNow } from '@backend/domain/helpcenter/indexnow';
import { HelpJobKinds } from '@backend/domain/helpcenter/jobs';
import { FakeTranslator } from '@backend/domain/helpcenter/translate/testing/fake-translator';
import { InboundJobKinds } from '@backend/domain/inbound/jobs';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobKinds } from '@backend/domain/jobs/prune';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { NotificationJobKinds } from '@backend/domain/notification/constants';
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import { createFakeDiscordFetch, jsonResponse } from '@backend/domain/notification/testing/fake-discord-fetch';
import { seedChannel, seedRule, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { OtaJobKinds } from '@backend/domain/ota/jobs';
import { createProjectDomain } from '@backend/domain/project/instance';
import { ReleaseJobKinds } from '@backend/domain/project/jobs';
import { RateLimitJobKinds } from '@backend/domain/ratelimit/jobs';
import { StatusJobKinds } from '@backend/domain/status/jobs';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { StorageJobKinds } from '@backend/domain/storage/jobs';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { expectOne } from '@backend/infra/db/rows';
import { jobs, jobSchedules, notificationDeliveries, users } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';

const T0 = new Date('2026-09-25T00:00:00.000Z');

describe('job runtime composition (pglite)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it('registers every domain handler and the platform schedules', async () => {
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: () => {},
      appOrigin: 'https://mocco.test',
      discord: undefined,
      storage: new StorageService({
        objects: new ObjectRepo(t.db),
        store: new FilesystemObjectStore({
          root: await mkdtemp(path.join(tmpdir(), 'mocco-jobs-')),
          baseUrl: 'https://mocco.test/api/ext/internal/storage',
          signer: new StorageUrlSigner('test-signing-key'),
        }),
      }),
    });

    const report = await runner.tick({ budgetMs: 10_000, maxJobs: 20 });

    expect(report).toMatchObject({ ran: 20, errors: [], outcomes: { succeeded: 20 } });
    const schedules = await t.db.select().from(jobSchedules);
    expect(new Set(schedules.map(schedule => schedule.kind))).toEqual(
      new Set([
        JobKinds.prune,
        EventJobKinds.prune,
        NotificationJobKinds.reconcile,
        NotificationJobKinds.prune,
        InboundJobKinds.republishStale,
        InboundJobKinds.prune,
        StorageJobKinds.gc,
        RateLimitJobKinds.prune,
        ReleaseJobKinds.reconcile,
        OtaJobKinds.pruneUploadSessions,
        OtaJobKinds.rollupMetrics,
        OtaJobKinds.pruneMetrics,
        FlagJobKinds.expireChangesets,
        FlagJobKinds.detectStale,
        FlagJobKinds.staleDigest,
        StatusJobKinds.maintenanceTick,
        StatusJobKinds.snapshotPublish,
        StatusJobKinds.retention,
        StatusJobKinds.evaluate,
        StatusJobKinds.rollup,
        StatusJobKinds.subscribersPrune,
      ]),
    );
    expect(schedules.every(schedule => schedule.workspaceId === null)).toBe(true);
    const ran = await t.db.select().from(jobs);
    expect(ran.every(job => job.status === JobStatuses.succeeded)).toBe(true);
  });

  it('delivers a governance event to a Discord channel end to end', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel, { eventType: 'gate.pending' });
    const fake = createFakeDiscordFetch(jsonResponse(200, { id: '4242' }));
    const kicked: Promise<unknown>[] = [];
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: promise => {
        kicked.push(promise);
      },
      appOrigin: 'https://mocco.test',
      discord: new DiscordApi({ fetch: fake.fetch, botToken: 'bot', now: () => T0 }),
      storage: undefined,
    });
    // A publisher's bus (its kicks are dropped: the tick below runs the event job).
    const publisher = createEventBus({
      db: t.db,
      queue: new PostgresJobQueue({
        jobs: new JobRepo(t.db),
        now: () => T0,
        runOne: async () => await Promise.resolve(null),
        waitUntil: () => {},
      }),
      now: () => T0,
      appOrigin: 'https://mocco.test',
    });
    const runId = randomUUID();
    const facts = { repo: 'fi-workers/api', pipeline: 'deploy', gate: 'production' };
    await publisher.publish({
      type: DomainEventTypes.gatePending,
      workspaceId,
      subject: { type: 'run_gate', id: randomUUID() },
      payload: {
        workspaceId,
        runId,
        repoFullName: facts.repo,
        pipelineName: facts.pipeline,
        commitSha: 'abc1234',
        linkPath: `/workspaces/${workspaceId}/runs/${runId}`,
        gateName: facts.gate,
        gateItemIndex: 1,
        facts,
      },
    });

    // The tick hands the event to the fan-out, which queues and kicks the delivery.
    await runner.tick({ budgetMs: 10_000, maxJobs: 10 });
    await Promise.all(kicked);

    const [delivery] = await t.db.select().from(notificationDeliveries);
    expect(delivery).toMatchObject({ status: DeliveryStatuses.sent, externalMessageId: '4242' });
    expect(fake.requests.map(request => new URL(request.url).pathname)).toEqual([
      `/api/v10/channels/${channel.externalId}/messages`,
    ]);
    const deliverJob = await t.db.select().from(jobs).where(eq(jobs.kind, NotificationJobKinds.deliver));
    expect(deliverJob.map(job => job.status)).toEqual([JobStatuses.succeeded]);
  });

  it('delivers deploy.released to a channel with a rule on it', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel, { eventType: DomainEventTypes.deployReleased });
    const fake = createFakeDiscordFetch(jsonResponse(200, { id: '4343' }));
    const kicked: Promise<unknown>[] = [];
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: promise => {
        kicked.push(promise);
      },
      appOrigin: 'https://mocco.test',
      discord: new DiscordApi({ fetch: fake.fetch, botToken: 'bot', now: () => T0 }),
      storage: undefined,
    });
    const publisher = createEventBus({
      db: t.db,
      queue: new PostgresJobQueue({
        jobs: new JobRepo(t.db),
        now: () => T0,
        runOne: async () => await Promise.resolve(null),
        waitUntil: () => {},
      }),
      now: () => T0,
      appOrigin: 'https://mocco.test',
    });
    const runId = randomUUID();
    await publisher.publish({
      type: DomainEventTypes.deployReleased,
      workspaceId,
      subject: { type: 'run', id: runId },
      payload: {
        workspaceId,
        runId,
        repoFullName: 'fi-workers/api',
        pipelineName: 'deploy',
        commitSha: 'def5678abc',
        linkPath: `/workspaces/${workspaceId}/runs/${runId}`,
        facts: { repo: 'fi-workers/api', pipeline: 'deploy' },
        repoId: randomUUID(),
        projectIds: [randomUUID()],
        previousReleaseSha: 'abc1234def',
        gates: [{ gateId: randomUUID(), name: 'production', resumedBy: [{ userId: randomUUID(), role: 'deployer' }] }],
        resumedBy: [{ userId: randomUUID(), role: 'deployer' }],
        releasedAt: T0.toISOString(),
      },
    });

    // The tick hands the event to the fan-out, which queues and kicks the delivery.
    await runner.tick({ budgetMs: 10_000, maxJobs: 10 });
    await Promise.all(kicked);

    const [delivery] = await t.db.select().from(notificationDeliveries);
    expect(delivery).toMatchObject({ status: DeliveryStatuses.sent, externalMessageId: '4343' });
    const [request] = fake.requests;
    expect(request?.body).toContain('Released: fi-workers/api');
    expect(request?.body).toContain('Since abc1234.');
  });

  it('refreshes the public help pages when a background job finishes a translation', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const authorId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'SYT', handle: 'syt' });
    const rebuilt: string[][] = [];
    const submitted: string[][] = [];
    const kicked: Promise<unknown>[] = [];
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: promise => {
        kicked.push(promise);
      },
      appOrigin: 'https://mocco.test',
      discord: undefined,
      storage: undefined,
      translator: new FakeTranslator(),
      helpRevalidator: {
        revalidate: async paths => {
          rebuilt.push([...paths]);
          await Promise.resolve();
        },
      },
      helpIndexNow: new HelpIndexNow({
        db: t.db,
        secret: 'indexnow-secret',
        originOf: slug => `https://${slug}.help.mocco.test`,
        sender: {
          submit: async submission => {
            submitted.push([...submission.urls]);
            await Promise.resolve();
          },
        },
      }),
    });
    // The console's domain publishes; it only queues the translation (its kicks are dropped).
    const help = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      translator: new FakeTranslator(),
      queue: new PostgresJobQueue({
        jobs: new JobRepo(t.db),
        now: () => T0,
        runOne: async () => {},
        waitUntil: () => {},
      }),
    });
    await help.helpSites.enable(workspaceId, project.id, authorId, {
      slug: 'syt',
      sourceLocale: 'ko',
      locales: ['en'],
    });
    const collection = await help.helpAuthoring.createCollection(workspaceId, project.id, {
      title: 'Start',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, project.id, {
      collectionId: collection.id,
      title: 'Basics',
    });
    const article = await help.helpAuthoring.createArticle(workspaceId, project.id, authorId, {
      sectionId: section.id,
      title: 'Widget',
      slug: 'widget',
    });
    await help.helpAuthoring.saveDraft(workspaceId, project.id, authorId, {
      articleId: article.id,
      title: 'Widget',
      body: 'Hello.',
    });
    await help.helpAuthoring.publish(workspaceId, project.id, authorId, article.id);

    await runner.tick({ budgetMs: 10_000, maxJobs: 50 });
    await Promise.all(kicked);

    const english = `/_sites/syt/en/articles/${article.shortId}-widget`;
    expect(rebuilt).toContainEqual(expect.arrayContaining(['/_sites/syt/en', english]));
    const queued = await t.db.select().from(jobs);
    const translated = queued.filter(job => job.kind === HelpJobKinds.translate);
    expect(translated.map(job => job.status)).toEqual([JobStatuses.succeeded]);
    // The IndexNow submission rides its own job, as on the request path.
    expect(queued.some(job => job.kind === HelpJobKinds.indexNow)).toBe(true);
    expect(submitted).toContainEqual(
      expect.arrayContaining([`https://syt.help.mocco.test/en/articles/${article.shortId}-widget`]),
    );
  });
});
