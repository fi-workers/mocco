import { randomUUID } from 'node:crypto';

import { deployReleasedPayloadSchema, DomainEventTypes, runEventPayloadSchema } from '@mocco/common/events';
import { ExecutorIds } from '@mocco/common/execution';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createEventHandlers, pruneEvents } from '@backend/domain/events/jobs';
import { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { FailingEventPublisher } from '@backend/domain/events/testing/event-bus';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { GateService } from '@backend/domain/governance/GateService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { JobHandlerRegistry } from '@backend/domain/jobs/handlers';
import { JobRunner } from '@backend/domain/jobs/JobRunner';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobScheduleRepo } from '@backend/domain/jobs/repos/job-schedule.repo';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { createReleaseService } from '@backend/domain/project/compose';
import { createReleaseHandlers, reconcileReleases } from '@backend/domain/project/jobs';
import { RELEASE_RECONCILE_WINDOW_MS, type ReleaseService } from '@backend/domain/project/ReleaseService';
import { RELEASE_SUBSCRIBER } from '@backend/domain/project/subscribers';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  domainEventDeliveries,
  domainEvents,
  projectRepos,
  projects,
  providerConnections,
  releases,
  repos,
  runs,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { MoccoConfig } from '@mocco/common/mocco-config';

const DAY = 24 * 60 * 60 * 1000;

/** A gate, then the deploy step: a run that passes it is a release. */
const GATED: MoccoConfig = {
  version: 2,
  pipeline: 'deploy',
  steps: [
    { kind: 'gate', name: 'prod', resume: [{ role: 'deployer', count: 1 }] },
    { kind: 'step', run: 'ship', executor: 'generic' },
  ],
};

/** No gate: a run that succeeds is not a release. */
const UNGATED: MoccoConfig = {
  version: 2,
  pipeline: 'ci',
  steps: [{ kind: 'step', run: 'test', executor: 'generic' }],
};

describe('ReleaseService (pglite)', () => {
  let t: TestDb;
  let clock: { offsetMs: number };
  let bus: EventBus;
  let runner: JobRunner;
  let queue: PostgresJobQueue;
  let releaseService: ReleaseService;
  let executor: FakeExecutor;
  let commits: CommitRepo;
  let configs: CommitConfigRepo;
  let workspaceId: string;
  let deployer: string;
  let triggerer: string;
  let repoId: string;

  // Runs finish on the wall clock (RunService stamps `new Date()`); the job clock can be
  // moved ahead of it to age events for pruning.
  const now = () => new Date(Date.now() + clock.offsetMs);

  const governance = (publisher: EventPublisher) => {
    const runService = new RunService({
      bus: publisher,
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits,
      configs,
      executors: new Map([[ExecutorIds.generic, executor]]),
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      waitUntil: () => {},
    });
    const gateService = new GateService({
      bus: publisher,
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runService.resumeFromGate(run, gateItemIndex),
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
    });
    return { runService, gateService };
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = { offsetMs: 0 };
    executor = new FakeExecutor();
    commits = new CommitRepo(t.db);
    configs = new CommitConfigRepo(t.db);
    const jobRepo = new JobRepo(t.db);
    // Kicks are dropped: deliveries run when a test ticks, so retries are under its control.
    queue = new PostgresJobQueue({
      jobs: jobRepo,
      now,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    // The production subscriber list, so the test also proves the registration.
    bus = createEventBus({ db: t.db, queue, now, appOrigin: 'https://mocco.test' });
    releaseService = createReleaseService(t.db, { bus });
    runner = new JobRunner({
      jobs: jobRepo,
      schedules: new JobScheduleRepo(t.db, jobRepo),
      handlers: new JobHandlerRegistry([
        ...createEventHandlers({ bus, events: new DomainEventRepo(t.db) }),
        ...createReleaseHandlers({ releases: releaseService }),
      ]),
      now,
      random: () => 0,
      workerId: 'test',
    });

    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const seedUser = async () =>
      expectOne(
        await t.db
          .insert(users)
          .values({ email: `${randomUUID()}@example.com` })
          .returning(),
      ).id;
    deployer = await seedUser();
    triggerer = await seedUser();
    const role = await new RoleRepo(t.db).create({ workspaceId, name: 'deployer' });
    await new RoleMembershipRepo(t.db).add({ workspaceId, roleId: role.id, userId: deployer });
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    repoId = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: connection.id,
          externalRepoId: randomUUID(),
          owner: 'fi-workers',
          name: 'api',
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
  });

  afterEach(async () => {
    await t.close();
  });

  const tick = async () => await runner.tick({ budgetMs: 60_000, maxJobs: 100 });

  async function seedProject(handle: string): Promise<string> {
    const project = expectOne(await t.db.insert(projects).values({ workspaceId, name: handle, handle }).returning());
    await t.db.insert(projectRepos).values({ workspaceId, projectId: project.id, repoId });
    return project.id;
  }

  async function seedCommit(config: MoccoConfig): Promise<string> {
    const sha = `sha-${randomUUID()}`;
    await commits.upsertMany([
      {
        repoId,
        sha,
        branch: 'main',
        message: 'msg',
        authorName: 'Author',
        authorEmail: 'author@example.com',
        committedAt: new Date(),
      },
    ]);
    const listed = await commits.listByRepo(repoId, null, 50);
    const commit = listed.find(row => row.sha === sha);
    if (commit === undefined) {
      throw new Error('expected seeded commit');
    }
    await configs.upsert({
      commitId: commit.id,
      present: true,
      rawYaml: 'version: 2',
      parsedJson: config,
      valid: true,
      validationErrors: [],
    });
    return commit.id;
  }

  /** Trigger a run of `config`, resume its gate (if any) and report its last step. */
  async function runPipeline(
    config: MoccoConfig,
    options: { publisher?: EventPublisher; lastStep?: 'succeeded' | 'failed' } = {},
  ): Promise<string> {
    const { runService, gateService } = governance(options.publisher ?? bus);
    const run = await runService.trigger(workspaceId, await seedCommit(config), triggerer);
    if (run.state === 'awaiting_gate') {
      await gateService.resume(workspaceId, run.id, run.currentIndex, deployer, 'resume');
    }
    const dispatch = executor.dispatches.at(-1);
    if (dispatch === undefined) {
      throw new Error('expected a dispatched step');
    }
    await runService.applyCallback(dispatch.ctx.callbackToken, {
      runId: run.id,
      stepIndex: dispatch.ctx.stepIndex,
      status: options.lastStep ?? 'succeeded',
    });
    return run.id;
  }

  const releaseRows = async () => await t.db.select().from(releases).orderBy(asc(releases.releasedAt));
  const releasedEvents = async () =>
    await t.db.select().from(domainEvents).where(eq(domainEvents.type, DomainEventTypes.deployReleased));

  it('registers the subscriber on run.succeeded in the shared composition', () => {
    expect(bus.subscribersFor(DomainEventTypes.runSucceeded)).toContain(RELEASE_SUBSCRIBER);
  });

  it('records one release per linked project and publishes one deploy.released, even when redelivered', async () => {
    const api = await seedProject('api');
    const web = await seedProject('web');
    await t.db.insert(projects).values({ workspaceId, name: 'other', handle: 'other' });

    const runId = await runPipeline(GATED);
    await tick();

    const rows = await releaseRows();
    expect(new Set(rows.map(row => row.projectId))).toEqual(new Set([api, web]));
    expect(rows[0]).toMatchObject({ runId, repoId, gates: [{ name: 'prod', resumedBy: [{ userId: deployer }] }] });
    const [event] = await releasedEvents();
    expect(event).toMatchObject({ subjectType: 'run', subjectId: runId, dedupeKey: `deploy.released:${runId}` });
    expect(event?.payload).toMatchObject({
      runId,
      repoId,
      repoFullName: 'fi-workers/api',
      previousReleaseSha: null,
      resumedBy: [{ userId: deployer, role: 'deployer' }],
    });
    expect(new Set(deployReleasedPayloadSchema.parse(event?.payload).projectIds)).toEqual(new Set([api, web]));

    // A redelivery that reaches the subscriber again (the ledger lost, a crash before it was
    // written), and the service called directly twice more.
    await t.db.delete(domainEventDeliveries);
    const succeeded = expectOne(
      await t.db.select().from(domainEvents).where(eq(domainEvents.type, DomainEventTypes.runSucceeded)),
    );
    await bus.publish({
      type: DomainEventTypes.runSucceeded,
      workspaceId,
      subject: { type: 'run', id: runId },
      dedupeKey: succeeded.dedupeKey ?? undefined,
      payload: runEventPayloadSchema.parse(succeeded.payload),
    });
    await tick();
    await releaseService.recordRun(workspaceId, runId);
    await expect(releaseService.recordRun(workspaceId, runId)).resolves.toMatchObject({ inserted: 0 });

    expect(await releaseRows()).toHaveLength(2);
    expect(await releasedEvents()).toHaveLength(1);
  });

  it('names the previous release of the repo and lists a project newest first', async () => {
    const api = await seedProject('api');
    const first = await runPipeline(GATED);
    await tick();
    const second = await runPipeline(GATED);
    await tick();

    const listed = await releaseService.listForProject(workspaceId, api, { limit: 10 });
    expect(listed.map(row => row.runId)).toEqual([second, first]);
    const events = await releasedEvents();
    const payloadOf = (runId: string) =>
      deployReleasedPayloadSchema.parse(events.find(event => event.subjectId === runId)?.payload);
    expect(payloadOf(first).previousReleaseSha).toBeNull();
    expect(payloadOf(second).previousReleaseSha).toBe(listed[1]?.commitSha);
  });

  it('records nothing for a run without a resumed gate', async () => {
    await seedProject('api');
    const runId = await runPipeline(UNGATED);
    await tick();

    expect(await t.db.select().from(runs).where(eq(runs.id, runId))).toMatchObject([{ state: 'succeeded' }]);
    expect(await releaseRows()).toEqual([]);
    expect(await releasedEvents()).toEqual([]);
    await expect(releaseService.reconcile(now())).resolves.toBe(0);
  });

  it('records nothing for a run that failed after its gate was resumed', async () => {
    await seedProject('api');
    await runPipeline(GATED, { lastStep: 'failed' });
    await tick();

    expect(await releaseRows()).toEqual([]);
    expect(await releasedEvents()).toEqual([]);
    await expect(releaseService.reconcile(now())).resolves.toBe(0);
  });

  it('does not give a project linked after the release the past release', async () => {
    await seedProject('api');
    await runPipeline(GATED);
    await tick();
    await seedProject('later');

    await expect(releaseService.reconcile(now())).resolves.toBe(0);
    expect(await releaseRows()).toHaveLength(1);
  });

  it('keeps the run succeeded when publishing fails, and the reconcile job fills the gap once', async () => {
    const api = await seedProject('api');
    const failing = new FailingEventPublisher();
    const runId = await runPipeline(GATED, { publisher: failing });

    expect(failing.attempts).toBeGreaterThan(0);
    expect(await t.db.select().from(runs).where(eq(runs.id, runId))).toMatchObject([{ state: 'succeeded' }]);
    expect(await releaseRows()).toEqual([]);

    await expect(releaseService.reconcile(now())).resolves.toBe(1);
    expect(await releaseRows()).toMatchObject([{ projectId: api, runId }]);
    expect(await releasedEvents()).toHaveLength(1);

    await expect(releaseService.reconcile(now())).resolves.toBe(0);
    expect(await releaseRows()).toHaveLength(1);
    expect(await releasedEvents()).toHaveLength(1);
  });

  it('publishes the missing event when the rows were written but the publish failed', async () => {
    await seedProject('api');
    const runId = await runPipeline(GATED, { publisher: new FailingEventPublisher() });
    const broken = createReleaseService(t.db, { bus: new FailingEventPublisher() });

    // The subscriber's publish throws (its job would retry); the rows stay.
    await expect(broken.recordRun(workspaceId, runId)).rejects.toThrow('event bus is down');
    expect(await releaseRows()).toHaveLength(1);
    expect(await releasedEvents()).toEqual([]);

    await expect(releaseService.reconcile(now())).resolves.toBe(1);
    expect(await releaseRows()).toHaveLength(1);
    expect(await releasedEvents()).toHaveLength(1);
  });

  it('runs as the releases.reconcile job, and leaves runs outside its window alone', async () => {
    await seedProject('api');
    await runPipeline(GATED, { publisher: new FailingEventPublisher() });

    clock.offsetMs = RELEASE_RECONCILE_WINDOW_MS + DAY;
    await queue.enqueue(reconcileReleases, {});
    await tick();
    expect(await releaseRows()).toEqual([]);

    clock.offsetMs = 0;
    await queue.enqueue(reconcileReleases, {});
    await tick();
    expect(await releaseRows()).toHaveLength(1);
    expect(await releasedEvents()).toHaveLength(1);
  });

  it('leaves releases and the audit log in place when the events are pruned', async () => {
    await seedProject('api');
    await runPipeline(GATED);
    await tick();
    const audit = await t.db.select().from(auditLog);
    expect(audit.length).toBeGreaterThan(0);
    expect(await releasedEvents()).toHaveLength(1);

    clock.offsetMs = 31 * DAY;
    await queue.enqueue(pruneEvents, {});
    await tick();

    expect(await t.db.select().from(domainEvents)).toEqual([]);
    expect(await releaseRows()).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(audit.length);
    // A pruned event is no gap: past the window, reconcile does not republish it.
    await expect(releaseService.reconcile(now())).resolves.toBe(0);
  });
});
