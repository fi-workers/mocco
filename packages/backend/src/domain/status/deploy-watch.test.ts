import { randomUUID } from 'node:crypto';

import { DomainEventTypes } from '@mocco/common/events';
import { RunStates } from '@mocco/common/execution';
import {
  CheckOutcomes,
  ComponentImpacts,
  DeployWatch,
  IncidentOrigins,
  IncidentRunRelations,
  IncidentStatuses,
  LocationKinds,
  MonitorKinds,
  MonitorStates,
  StatusRunEventTypes,
  monitorInputSchema,
} from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import {
  DEPLOY_WATCH_FACTOR,
  LINKED_REPO_FACTOR,
  deployScore,
  rankReleases,
} from '@backend/domain/status/CorrelationService';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { DEPLOY_WATCH_SUBSCRIBER } from '@backend/domain/status/subscribers';
import { seedRelease, seedRepo } from '@backend/domain/status/testing/deploys';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import {
  runEvents,
  runs,
  statusIncidentRuns,
  statusIncidents,
  statusIncidentUpdates,
  statusMonitors,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { ProbeLocation } from '@backend/domain/status/ProbeService';
import type { StatusScope } from '@backend/domain/status/scope';
import type { MonitorInput } from '@mocco/common/status';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const MINUTE = 60_000;

describe('deploy watch scoring', () => {
  it('counts the run whose watch opened the incident twice', () => {
    const released = { releasedAt: new Date(T0.getTime() - 10 * MINUTE) };
    expect(deployScore(released, T0, false, true)).toBe(0.5 * DEPLOY_WATCH_FACTOR);
    expect(deployScore(released, T0, true, true)).toBe(0.5 * LINKED_REPO_FACTOR * DEPLOY_WATCH_FACTOR);

    // A closer release loses to the watched run, which is then the suspect.
    const ranked = rankReleases(
      [
        { runId: 'watched', projectId: 'p1', releasedAt: new Date(T0.getTime() - 10 * MINUTE) },
        { runId: 'closer', projectId: 'p1', releasedAt: new Date(T0.getTime() - 2 * MINUTE) },
      ],
      { startedAt: T0, projectId: 'p1', suspectedRunId: 'watched' },
      true,
    );
    expect(ranked.map(row => [row.runId, row.relation])).toEqual([
      ['watched', IncidentRunRelations.suspected],
      ['closer', IncidentRunRelations.beforeWindow],
    ]);
  });
});

describe('deploy watch (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let bus: EventBus;
  let scope: StatusScope;
  let other: StatusScope;
  let actor: string;
  let clock: Date;
  let fra: ProbeLocation;
  let repoId: string;

  const later = (ms: number) => new Date(clock.getTime() + ms);

  const current = async (monitorId: string) =>
    expectOne(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, monitorId)));

  /** Move the clock just past the monitor's next round and report `outcome` for it from fra. */
  const round = async (monitorId: string, outcome: typeof CheckOutcomes.ok | typeof CheckOutcomes.fail) => {
    const due = await current(monitorId);
    clock = new Date(due.nextRoundAt.getTime() + 1000);
    const { leases } = await status.statusProbes.lease(fra, { agentVersion: '1', capacity: 50 });
    await status.statusProbes.report(
      fra,
      leases
        .filter(lease => lease.monitorId === monitorId)
        .map(lease => ({
          leaseId: lease.leaseId,
          monitorId: lease.monitorId,
          roundAt: lease.roundAt,
          outcome,
          latencyMs: 100,
        })),
    );
    return await current(monitorId);
  };

  const newMonitor = async (on: StatusScope, name: string, extra: Partial<MonitorInput> = {}) => {
    const page = await status.statusPages.createPage(on, actor, { slug: randomUUID().slice(0, 8), title: name });
    const api = await status.statusPages.createComponent(on, page.id, { name: 'API' });
    return await status.statusMonitors.create(
      on,
      actor,
      monitorInputSchema.parse({
        name,
        spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health' },
        locationIds: [fra.id],
        components: [{ componentId: api.id, impactWhenDown: ComponentImpacts.majorOutage }],
        ...extra,
      }),
    );
  };

  /** Publish `deploy.released` the way the registry does, and deliver it to the watch. */
  const release = async (runId: string, projectIds: string[], releasedAt: Date) => {
    const { event } = await bus.publish({
      type: DomainEventTypes.deployReleased,
      workspaceId: scope.workspaceId,
      subject: { type: 'run', id: runId },
      dedupeKey: `deploy.released:${runId}`,
      occurredAt: releasedAt,
      payload: {
        workspaceId: scope.workspaceId,
        runId,
        repoFullName: 'acme/api',
        pipelineName: 'deploy',
        commitSha: 'abc1234',
        linkPath: `/workspaces/${scope.workspaceId}/runs/${runId}`,
        facts: { repo: 'acme/api', pipeline: 'deploy' },
        repoId,
        projectIds,
        previousReleaseSha: null,
        gates: [{ gateId: randomUUID(), name: 'production', resumedBy: [{ userId: actor, role: 'release' }] }],
        resumedBy: [{ userId: actor, role: 'release' }],
        releasedAt: releasedAt.toISOString(),
      },
    });
    await bus.deliver(event.id, DEPLOY_WATCH_SUBSCRIBER);
  };

  /** A release of the repo (linked to the main project) finished now, delivered to the watch. */
  const releaseNow = async () => {
    const runId = await seedRelease(t.db, {
      workspaceId: scope.workspaceId,
      repoId,
      projectIds: [scope.projectId],
      releasedAt: clock,
    });
    await release(runId, [scope.projectId], clock);
    return runId;
  };

  /** Passing rounds until the watch is over; returns the gaps between the rounds it ran. */
  const passUntilWatchEnds = async (monitorId: string, gaps: number[] = []): Promise<number[]> => {
    const before = await current(monitorId);
    if (before.watchUntil === null) {
      return gaps;
    }
    const after = await round(monitorId, CheckOutcomes.ok);
    return await passUntilWatchEnds(monitorId, [
      ...gaps,
      (after.nextRoundAt.getTime() - before.nextRoundAt.getTime()) / 1000,
    ]);
  };

  const timeline = async (runId: string) =>
    await t.db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(runEvents.seq);

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    // Kicks are dropped: the test delivers to the watch's subscriber itself.
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => clock,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    // The production subscriber list, so the test also proves the registration.
    bus = createEventBus({ db: t.db, queue, now: () => clock, appOrigin: 'https://mocco.test' });
    status = createStatusDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      events: bus,
      now: () => clock,
    });
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const { projects } = createProjectDomain(t.db);
    const acme = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    const blog = await projects.create(workspaceId, { name: 'Blog', handle: 'blog' });
    scope = { workspaceId, projectId: acme.id };
    other = { workspaceId, projectId: blog.id };
    repoId = await seedRepo(t.db, workspaceId, 'api', [scope.projectId]);
    await new TimeSeriesRetention({ db: t.db }).run(T0);
    const token = generateLocationToken();
    await new LocationRepo(t.db).insert({
      workspaceId: null,
      code: 'fra',
      name: 'fra',
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(token),
    });
    const location = await status.statusProbes.authenticate(token);
    if (location === undefined) {
      throw new Error('fixture location did not authenticate');
    }
    fra = location;
  });
  afterEach(async () => {
    await t.close();
  });

  it('starts on deploy.released, on the released projects’ monitors that are not paused', async () => {
    expect(bus.subscribersFor(DomainEventTypes.deployReleased)).toContain(DEPLOY_WATCH_SUBSCRIBER);
    const watched = await newMonitor(scope, 'API health');
    const paused = await newMonitor(scope, 'Paused');
    const elsewhere = await newMonitor(other, 'Blog health');
    await status.statusMonitors.pause(scope, actor, paused.id);
    expect(await round(watched.id, CheckOutcomes.ok)).toMatchObject({ state: MonitorStates.up });
    clock = later(10_000);

    const runId = await releaseNow();

    expect(await current(watched.id)).toMatchObject({
      watchUntil: new Date(clock.getTime() + DeployWatch.durationMs),
      watchIntervalSeconds: DeployWatch.intervalSeconds,
      watchRunId: runId,
      // The round that was due later is pulled to now.
      nextRoundAt: clock,
    });
    const unwatched = expect.objectContaining({ watchUntil: null, watchIntervalSeconds: null, watchRunId: null });
    expect([await current(paused.id), await current(elsewhere.id)]).toEqual([unwatched, unwatched]);

    // A release delivered more than 15 minutes after it finished starts nothing.
    const late = await seedRelease(t.db, {
      workspaceId: scope.workspaceId,
      repoId,
      projectIds: [other.projectId],
      releasedAt: new Date(clock.getTime() - 16 * MINUTE),
    });
    await release(late, [other.projectId], new Date(clock.getTime() - 16 * MINUTE));
    expect(await current(elsewhere.id)).toMatchObject({ watchRunId: null });
  });

  it('checks every 30 seconds during the watch, and at the normal interval once it ends', async () => {
    const monitor = await newMonitor(scope, 'API health');
    await round(monitor.id, CheckOutcomes.ok);
    clock = later(10_000);
    await releaseNow();

    const gaps = await passUntilWatchEnds(monitor.id);

    // 15 minutes of 30-second rounds, then the round past the end clears the watch.
    expect(gaps.slice(0, -1).every(gap => gap === DeployWatch.intervalSeconds)).toBe(true);
    expect(gaps.length).toBeGreaterThanOrEqual(DeployWatch.durationMs / 1000 / DeployWatch.intervalSeconds);
    expect(gaps.at(-1)).toBe(60);
    expect(await current(monitor.id)).toMatchObject({
      state: MonitorStates.up,
      watchUntil: null,
      watchIntervalSeconds: null,
      watchRunId: null,
    });
    const before = await current(monitor.id);
    const { nextRoundAt } = await round(monitor.id, CheckOutcomes.ok);
    expect(nextRoundAt.getTime() - before.nextRoundAt.getTime()).toBe(60_000);
  });

  it('opens a deploy_watch incident on the run and adds the failure to its timeline, leaving the run alone', async () => {
    const monitor = await newMonitor(scope, 'API health');
    await round(monitor.id, CheckOutcomes.ok);
    clock = later(10_000);
    const runId = await releaseNow();
    const runBefore = expectOne(await t.db.select().from(runs).where(eq(runs.id, runId)));

    expect(await round(monitor.id, CheckOutcomes.fail)).toMatchObject({ state: MonitorStates.suspect });
    expect(await round(monitor.id, CheckOutcomes.fail)).toMatchObject({ state: MonitorStates.down });

    const incident = expectOne(await t.db.select().from(statusIncidents));
    expect(incident).toMatchObject({ origin: IncidentOrigins.deployWatch, suspectedRunId: runId });
    const update = expectOne(await t.db.select().from(statusIncidentUpdates));
    expect(update.bodyMd).toBe(
      'The monitor "API health" started failing within 1 min of a deploy. We are looking into it.',
    );

    // The incident lists the run as its suspect, with the linked-repo and watch factors.
    const link = expectOne(await t.db.select().from(statusIncidentRuns));
    expect(link).toMatchObject({ incidentId: incident.id, runId, relation: IncidentRunRelations.suspected });
    const expected = deployScore({ releasedAt: runBefore.finishedAt ?? T0 }, incident.startedAt, true, true);
    expect(link.score).toBeCloseTo(expected, 5);
    // Recomputing the suggestions keeps the factor: it comes from the incident, not the monitor.
    await status.statusCorrelation.correlate(scope, incident.id);
    expect(expectOne(await t.db.select().from(statusIncidentRuns)).score).toBeCloseTo(expected, 5);

    // The run's timeline points back at the incident.
    const event = expectOne(await timeline(runId));
    expect(event).toMatchObject({
      type: StatusRunEventTypes.postDeployCheckFailed,
      workspaceId: scope.workspaceId,
      payload: {
        monitorId: monitor.id,
        monitorName: 'API health',
        incidentId: incident.id,
        incidentOpened: true,
        linkPath: `/workspaces/${scope.workspaceId}/p/${scope.projectId}/status/incidents/${incident.id}`,
      },
    });
    expect(await status.statusCorrelation.incidentsForRun(scope.workspaceId, runId)).toEqual([
      expect.objectContaining({ incidentId: incident.id, relation: IncidentRunRelations.suspected }),
    ]);

    // No enforcement: the run's state and timestamps are as they were.
    const runAfter = expectOne(await t.db.select().from(runs).where(eq(runs.id, runId)));
    expect(runAfter).toEqual(runBefore);
    expect(runAfter.state).toBe(RunStates.succeeded);
  });

  it('keeps an outage that began before the deploy on its incident, and still tells the run', async () => {
    const monitor = await newMonitor(scope, 'API health');
    await round(monitor.id, CheckOutcomes.fail);
    expect(await round(monitor.id, CheckOutcomes.fail)).toMatchObject({ state: MonitorStates.down });
    expect(await round(monitor.id, CheckOutcomes.ok)).toMatchObject({ state: MonitorStates.recovering });
    clock = later(10_000);
    const runId = await releaseNow();

    expect(await round(monitor.id, CheckOutcomes.fail)).toMatchObject({ state: MonitorStates.down });

    const incident = expectOne(await t.db.select().from(statusIncidents));
    expect(incident).toMatchObject({
      origin: IncidentOrigins.monitor,
      suspectedRunId: null,
      status: IncidentStatuses.identified,
    });
    expect(expectOne(await timeline(runId)).payload).toMatchObject({ incidentId: incident.id, incidentOpened: false });
  });

  it('opens a plain monitor incident for an outage after the watch ended', async () => {
    const monitor = await newMonitor(scope, 'API health');
    await round(monitor.id, CheckOutcomes.ok);
    clock = later(10_000);
    const runId = await releaseNow();
    await passUntilWatchEnds(monitor.id);

    await round(monitor.id, CheckOutcomes.fail);
    expect(await round(monitor.id, CheckOutcomes.fail)).toMatchObject({ state: MonitorStates.down });

    const incident = expectOne(await t.db.select().from(statusIncidents));
    expect(incident).toMatchObject({ origin: IncidentOrigins.monitor, suspectedRunId: null });
    expect(expectOne(await t.db.select().from(statusIncidentUpdates)).bodyMd).toBe(
      'The monitor "API health" is failing its checks. We are looking into it.',
    );
    expect(await timeline(runId)).toEqual([]);
    // The release is still suggested by the usual correlation, without the watch factor.
    const link = expectOne(await t.db.select().from(statusIncidentRuns));
    expect(link.runId).toBe(runId);
    const released = expectOne(await t.db.select().from(runs).where(eq(runs.id, runId))).finishedAt ?? T0;
    expect(link.score).toBeCloseTo(deployScore({ releasedAt: released }, incident.startedAt, true), 5);
  });
});
