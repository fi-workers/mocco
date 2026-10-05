import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { DomainEventTypes, StatusEventTypes } from '@mocco/common/events';
import { RunStates } from '@mocco/common/execution';
import { GateStates } from '@mocco/common/governance';
import {
  CheckOutcomes,
  ComponentImpacts,
  ComponentStatuses,
  IncidentPolicies,
  IncidentVisibilities,
  LocationKinds,
  MaintenanceStatuses,
  MonitorKinds,
  MonitorStates,
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
import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { MAINTENANCE_END_NOTES } from '@backend/domain/status/MaintenanceService';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { MaintenanceComponentRepo } from '@backend/domain/status/repos/maintenance-component.repo';
import { MaintenanceSubscribers } from '@backend/domain/status/subscribers';
import { seedRepo, seedRun } from '@backend/domain/status/testing/deploys';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  domainEvents,
  runGates,
  runs,
  statusIncidents,
  statusMaintenanceComponents,
  statusMaintenances,
  statusMonitors,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { ProbeLocation } from '@backend/domain/status/ProbeService';
import type { StatusScope } from '@backend/domain/status/scope';
import type { RunState } from '@mocco/common/execution';

const T0 = new Date('2026-10-06T09:00:00.000Z');
const MINUTE = 60_000;
const APP_ORIGIN = 'https://mocco.test';

describe('maintenance from gated runs (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let bus: EventBus;
  let scope: StatusScope;
  let other: StatusScope;
  let actor: string;
  let clock: Date;
  let repoId: string;
  let fra: ProbeLocation;

  const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

  /** A page with an API and a Dashboard component. */
  const newPage = async (on: StatusScope = scope) => {
    const page = await status.statusPages.createPage(on, actor, { slug: randomUUID().slice(0, 8), title: 'Status' });
    const api = await status.statusPages.createComponent(on, page.id, { name: 'API' });
    const web = await status.statusPages.createComponent(on, page.id, { name: 'Dashboard' });
    return { page, api, web };
  };

  const announce = async (pageId: string, componentIds: string[], gateName = 'production', expectedMinutes = 20) =>
    await status.statusMaintenances.setGateMaintenance(scope, actor, {
      pageId,
      gateName,
      title: 'Deploying the API',
      expectedMinutes,
      componentIds,
    });

  /** A run of the repo paused at its `name` gate. */
  const newRun = async (name = 'production') => {
    const { runId } = await seedRun(t.db, {
      workspaceId: scope.workspaceId,
      repoId,
      finishedAt: clock,
      state: RunStates.awaitingGate,
    });
    const gate = expectOne(
      await t.db
        .insert(runGates)
        .values({
          workspaceId: scope.workspaceId,
          runId,
          itemIndex: 1,
          name,
          requirements: { resume: [{ role: 'release', count: 1 }], prevent_self: false, reason_required: false },
        })
        .returning(),
    );
    return { runId, gateId: gate.id, name };
  };

  const subjectOf = (runId: string) => ({
    workspaceId: scope.workspaceId,
    runId,
    repoFullName: 'acme/api',
    pipelineName: 'deploy',
    commitSha: 'abc1234',
    linkPath: `/workspaces/${scope.workspaceId}/runs/${runId}`,
  });

  const setRunState = async (runId: string, state: RunState) => {
    await t.db.update(runs).set({ state }).where(eq(runs.id, runId));
  };

  /** Resume the gate the way GateService does, and deliver `gate.resumed` to maintenance. */
  const resume = async (run: { runId: string; gateId: string; name: string }) => {
    await setRunState(run.runId, RunStates.running);
    await t.db.update(runGates).set({ state: GateStates.resumed }).where(eq(runGates.id, run.gateId));
    const { event } = await bus.publish({
      type: DomainEventTypes.gateResumed,
      workspaceId: scope.workspaceId,
      subject: { type: 'run_gate', id: run.gateId },
      dedupeKey: `gate.resumed:${run.gateId}`,
      payload: {
        ...subjectOf(run.runId),
        gateName: run.name,
        gateItemIndex: 1,
        facts: { repo: 'acme/api', pipeline: 'deploy', gate: run.name },
        actorUserId: actor,
        resumedBy: [{ userId: actor, role: 'release' }],
      },
    });
    await bus.deliver(event.id, MaintenanceSubscribers.gateResumed);
  };

  /** Finish the run the way RunService does, and deliver its event to maintenance. */
  const finish = async (runId: string, state: typeof RunStates.succeeded | typeof RunStates.failed) => {
    await setRunState(runId, state);
    const facts = { repo: 'acme/api', pipeline: 'deploy' };
    const { event } =
      state === RunStates.succeeded
        ? await bus.publish({
            type: DomainEventTypes.runSucceeded,
            workspaceId: scope.workspaceId,
            subject: { type: 'run', id: runId },
            payload: { ...subjectOf(runId), facts },
          })
        : await bus.publish({
            type: DomainEventTypes.runFailed,
            workspaceId: scope.workspaceId,
            subject: { type: 'run', id: runId },
            payload: { ...subjectOf(runId), facts },
          });
    await bus.deliver(
      event.id,
      state === RunStates.succeeded ? MaintenanceSubscribers.runSucceeded : MaintenanceSubscribers.runFailed,
    );
  };

  const windows = async () => await t.db.select().from(statusMaintenances).orderBy(statusMaintenances.createdAt);

  const windowOf = async (runId: string) =>
    expectOne(await t.db.select().from(statusMaintenances).where(eq(statusMaintenances.runId, runId)));

  const actions = async () => {
    const rows = await t.db.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.seq);
    return rows.map(row => row.action);
  };

  const displayed = async (pageId: string) => {
    const { components } = await status.statusPages.getPage(scope, pageId);
    return components.map(component => component.displayedStatus);
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    // Kicks are dropped: the tests deliver to the maintenance subscribers themselves.
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => clock,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    // The production subscriber list, so the tests also prove the registration.
    bus = createEventBus({ db: t.db, queue, now: () => clock, appOrigin: APP_ORIGIN });
    status = createStatusDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      events: bus,
      appOrigin: APP_ORIGIN,
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
    // The repo is linked to Acme only.
    repoId = await seedRepo(t.db, workspaceId, 'api', [scope.projectId]);
  });
  afterEach(async () => {
    await t.close();
  });

  it('starts a window when the gate is resumed and completes it when the run succeeds', async () => {
    expect(bus.subscribersFor(DomainEventTypes.gateResumed)).toContain(MaintenanceSubscribers.gateResumed);
    expect(bus.subscribersFor(DomainEventTypes.runSucceeded)).toContain(MaintenanceSubscribers.runSucceeded);
    expect(bus.subscribersFor(DomainEventTypes.runFailed)).toContain(MaintenanceSubscribers.runFailed);
    expect(bus.subscribersFor(DomainEventTypes.gateRejected)).toContain(MaintenanceSubscribers.gateRejected);

    const { page, api } = await newPage();
    await announce(page.id, [api.id]);
    // Another gate's announcement, and the same gate on a project the repo isn't linked to.
    await announce(page.id, [api.id], 'staging');
    const elsewhere = await newPage(other);
    await status.statusMaintenances.setGateMaintenance(other, actor, {
      pageId: elsewhere.page.id,
      gateName: 'production',
      title: 'Blog deploy',
      expectedMinutes: 10,
      componentIds: [],
    });
    const run = await newRun();

    await resume(run);

    const window = await windowOf(run.runId);
    expect(window).toMatchObject({
      pageId: page.id,
      title: 'Deploying the API',
      status: MaintenanceStatuses.inProgress,
      scheduledStart: T0,
      scheduledEnd: at(20),
      actualStart: T0,
      gateId: run.gateId,
      overranAt: null,
    });
    expect(await windows()).toHaveLength(1);
    const links = await t.db.select().from(statusMaintenanceComponents);
    expect(links.map(link => [link.maintenanceId, link.componentId])).toEqual([[window.id, api.id]]);
    expect(await displayed(page.id)).toEqual([ComponentStatuses.maintenance, ComponentStatuses.operational]);

    // A redelivered resume starts no second window.
    await status.statusMaintenances.startForGate({
      workspaceId: scope.workspaceId,
      runId: run.runId,
      gateId: run.gateId,
      gateName: run.name,
    });
    expect(await windows()).toHaveLength(1);

    clock = at(12);
    await finish(run.runId, RunStates.succeeded);

    expect(await windowOf(run.runId)).toMatchObject({
      status: MaintenanceStatuses.completed,
      actualEnd: at(12),
      endNote: null,
    });
    expect(await displayed(page.id)).toEqual([ComponentStatuses.operational, ComponentStatuses.operational]);
    expect(await actions()).toEqual([
      AuditActions.statusPageCreated,
      AuditActions.statusGateMaintenanceSet,
      AuditActions.statusGateMaintenanceSet,
      AuditActions.statusPageCreated,
      AuditActions.statusGateMaintenanceSet,
      AuditActions.statusMaintenanceStarted,
      AuditActions.statusMaintenanceCompleted,
    ]);
  });

  it('still closes the window, with a note, when the run fails, is rejected or is canceled', async () => {
    const { page, api } = await newPage();
    await announce(page.id, [api.id]);
    const failed = await newRun();
    const rejected = await newRun();
    const canceled = await newRun();
    await Promise.all([failed, rejected, canceled].map(async run => await resume(run)));
    expect(await windows()).toHaveLength(3);

    clock = at(5);
    await finish(failed.runId, RunStates.failed);
    // A later gate rejected the run.
    await setRunState(rejected.runId, RunStates.rejected);
    const { event } = await bus.publish({
      type: DomainEventTypes.gateRejected,
      workspaceId: scope.workspaceId,
      subject: { type: 'run_gate', id: randomUUID() },
      payload: {
        ...subjectOf(rejected.runId),
        gateName: 'smoke',
        gateItemIndex: 3,
        facts: { repo: 'acme/api', pipeline: 'deploy', gate: 'smoke' },
        actorUserId: actor,
        reason: 'Smoke tests failed',
      },
    });
    await bus.deliver(event.id, MaintenanceSubscribers.gateRejected);
    // A canceled run publishes no event: the tick finds it.
    await setRunState(canceled.runId, RunStates.canceled);
    clock = at(6);
    expect(await status.statusMaintenances.tick(clock)).toEqual({ started: 0, completed: 1, overran: 0 });

    expect(await windowOf(failed.runId)).toMatchObject({
      status: MaintenanceStatuses.completed,
      actualEnd: at(5),
      endNote: MAINTENANCE_END_NOTES[RunStates.failed],
    });
    expect(await windowOf(rejected.runId)).toMatchObject({
      status: MaintenanceStatuses.completed,
      actualEnd: at(5),
      endNote: MAINTENANCE_END_NOTES[RunStates.rejected],
    });
    expect(await windowOf(canceled.runId)).toMatchObject({
      status: MaintenanceStatuses.completed,
      actualEnd: at(6),
      endNote: MAINTENANCE_END_NOTES[RunStates.canceled],
    });
    const completedAudits = await t.db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.action, AuditActions.statusMaintenanceCompleted));
    expect(new Set(completedAudits.map(row => (row.payload as { runState: string }).runState))).toEqual(
      new Set([RunStates.canceled, RunStates.failed, RunStates.rejected]),
    );

    // A run that finished before its resume was delivered starts nothing.
    const late = await newRun();
    await resume(late);
    await finish(late.runId, RunStates.succeeded);
    const finishedFirst = await newRun();
    await setRunState(finishedFirst.runId, RunStates.succeeded);
    await status.statusMaintenances.startForGate({
      workspaceId: scope.workspaceId,
      runId: finishedFirst.runId,
      gateId: finishedFirst.gateId,
      gateName: finishedFirst.name,
    });
    expect(
      await t.db.select().from(statusMaintenances).where(eq(statusMaintenances.runId, finishedFirst.runId)),
    ).toEqual([]);
  });

  it('flags an overrun once after the expected minutes, alerts, and keeps the window open until the run ends', async () => {
    const { page, api } = await newPage();
    await announce(page.id, [api.id], 'production', 20);
    const run = await newRun();
    await resume(run);

    expect(await status.statusMaintenances.tick(at(19))).toEqual({ started: 0, completed: 0, overran: 0 });
    clock = at(20);
    expect(await status.statusMaintenances.tick(clock)).toEqual({ started: 0, completed: 0, overran: 1 });
    // Once: the next tick flags nothing, and the window isn't completed at its scheduled end.
    expect(await status.statusMaintenances.tick(at(21))).toEqual({ started: 0, completed: 0, overran: 0 });
    expect(await windowOf(run.runId)).toMatchObject({ status: MaintenanceStatuses.inProgress, overranAt: at(20) });
    expect(await displayed(page.id)).toEqual([ComponentStatuses.maintenance, ComponentStatuses.operational]);

    const window = await windowOf(run.runId);
    const alert = expectOne(
      await t.db.select().from(domainEvents).where(eq(domainEvents.type, StatusEventTypes.statusMaintenanceOverran)),
    );
    expect(alert).toMatchObject({
      projectId: scope.projectId,
      subjectType: 'status_maintenance',
      subjectId: window.id,
      payload: {
        facts: { maintenance: 'Deploying the API' },
        message: {
          title: 'Maintenance overran: Deploying the API',
          url: `${APP_ORIGIN}/workspaces/${scope.workspaceId}/p/${scope.projectId}/status?page=${page.id}&tab=maintenance`,
          severity: 'warning',
          description: 'Expected to take 20 min. The run is still going, so the window stays open until it finishes.',
        },
      },
    });
    expect(await actions()).toContain(AuditActions.statusMaintenanceOverran);

    clock = at(31);
    await finish(run.runId, RunStates.succeeded);
    expect(await windowOf(run.runId)).toMatchObject({
      status: MaintenanceStatuses.completed,
      actualEnd: at(31),
      overranAt: at(20),
    });
    // The time it ran is excluded from uptime, overrun included.
    expect(await new MaintenanceComponentRepo(t.db).ranBetween(T0, at(60))).toEqual([
      { componentId: api.id, start: T0, end: at(31) },
    ]);
  });

  it("holds back a monitor's incident on the window's components until the run ends", async () => {
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
    const { page, api } = await newPage();
    const monitor = await status.statusMonitors.create(
      scope,
      actor,
      monitorInputSchema.parse({
        name: 'API health',
        spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health' },
        locationIds: [fra.id],
        components: [{ componentId: api.id, impactWhenDown: ComponentImpacts.majorOutage }],
        incidentPolicy: IncidentPolicies.publish,
      }),
    );
    const round = async (outcome: typeof CheckOutcomes.ok | typeof CheckOutcomes.fail) => {
      const due = expectOne(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, monitor.id)));
      clock = new Date(due.nextRoundAt.getTime() + 1000);
      const { leases } = await status.statusProbes.lease(fra, { agentVersion: '1', capacity: 50 });
      await status.statusProbes.report(
        fra,
        leases.map(lease => ({
          leaseId: lease.leaseId,
          monitorId: lease.monitorId,
          roundAt: lease.roundAt,
          outcome,
          latencyMs: 100,
        })),
      );
      return expectOne(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, monitor.id))).state;
    };
    await announce(page.id, [api.id], 'production', 60);
    const run = await newRun();
    await resume(run);

    await round(CheckOutcomes.fail);
    expect(await round(CheckOutcomes.fail)).toBe(MonitorStates.down);

    // `publish` is held back as a draft while the run's window covers the component.
    expect(expectOne(await t.db.select().from(statusIncidents)).visibility).toBe(IncidentVisibilities.draft);
    const alert = expectOne(
      await t.db.select().from(domainEvents).where(eq(domainEvents.type, StatusEventTypes.statusMonitorDown)),
    );
    expect(alert.payload).toMatchObject({
      facts: { duringMaintenance: true },
      message: { title: 'Down: API health (during maintenance)' },
    });

    // Once the run ended, the next outage is published.
    await finish(run.runId, RunStates.succeeded);
    await round(CheckOutcomes.ok);
    expect(await round(CheckOutcomes.ok)).toBe(MonitorStates.up);
    await round(CheckOutcomes.fail);
    expect(await round(CheckOutcomes.fail)).toBe(MonitorStates.down);
    const opened = await t.db.select().from(statusIncidents).orderBy(statusIncidents.createdAt);
    expect(opened.map(incident => incident.visibility)).toEqual([
      IncidentVisibilities.draft,
      IncidentVisibilities.published,
    ]);
  });

  it('sets, replaces and removes a gate maintenance on the project’s own page and components', async () => {
    const { page, api, web } = await newPage();
    const foreign = await newPage(other);

    const first = await announce(page.id, [api.id]);
    const replaced = await status.statusMaintenances.setGateMaintenance(scope, actor, {
      pageId: page.id,
      gateName: 'production',
      title: 'Deploying',
      expectedMinutes: 45,
      componentIds: [api.id, web.id, api.id],
    });
    expect(replaced).toMatchObject({ id: first.id, title: 'Deploying', expectedMinutes: 45 });
    expect(new Set(replaced.componentIds)).toEqual(new Set([api.id, web.id]));
    expect(replaced.componentIds).toHaveLength(2);
    expect(await status.statusMaintenances.listGateMaintenances(scope, page.id)).toHaveLength(1);

    // Another page's component, or another project's page, is not found.
    await expect(announce(page.id, [foreign.api.id])).rejects.toBeInstanceOf(StatusEntityNotFoundError);
    await expect(announce(foreign.page.id, [])).rejects.toBeInstanceOf(StatusEntityNotFoundError);
    await expect(status.statusMaintenances.deleteGateMaintenance(other, actor, first.id)).rejects.toBeInstanceOf(
      StatusEntityNotFoundError,
    );

    await status.statusMaintenances.deleteGateMaintenance(scope, actor, first.id);
    expect(await status.statusMaintenances.listGateMaintenances(scope, page.id)).toEqual([]);
    expect(await actions()).toContain(AuditActions.statusGateMaintenanceDeleted);
  });
});
