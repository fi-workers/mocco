import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AuditActions } from '@mocco/common/audit';
import { StatusEventTypes } from '@mocco/common/events';
import {
  CheckOutcomes,
  ComponentImpacts,
  ComponentStatuses,
  IncidentPolicies,
  IncidentRunRelations,
  IncidentSeverities,
  IncidentStatuses,
  IncidentVisibilities,
  LocationKinds,
  MonitorKinds,
  MonitorStates,
  httpMonitorSpecSchema,
  monitorInputSchema,
} from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { createTestEventBus } from '@backend/domain/events/testing/event-bus';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { NotificationSubscribers } from '@backend/domain/notification/constants';
import { renderEmbed } from '@backend/domain/notification/senders/discord';
import { seedChannel, seedRule } from '@backend/domain/notification/testing/seed';
import { createProjectDomain } from '@backend/domain/project/instance';
import { deriveComponentStatus } from '@backend/domain/status/component-status';
import { createSnapshotService, createStatusDomain } from '@backend/domain/status/compose';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { MonitorTransitionService } from '@backend/domain/status/MonitorTransitionService';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import { seedRelease, seedRepo } from '@backend/domain/status/testing/deploys';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  domainEvents,
  notificationDeliveries,
  statusIncidentMonitors,
  statusIncidents,
  statusIncidentUpdates,
  statusMonitors,
  statusMonitorStateChanges,
  statusPages,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { ProbeLocation } from '@backend/domain/status/ProbeService';
import type { StatusScope } from '@backend/domain/status/scope';
import type { MonitorInput } from '@mocco/common/status';

type ReportedOutcome = typeof CheckOutcomes.ok | typeof CheckOutcomes.fail;

const T0 = new Date('2026-10-05T09:00:00.000Z');
const APP_ORIGIN = 'https://mocco.test';

describe('deriveComponentStatus with monitors', () => {
  const { operational, maintenance, degraded, partialOutage, majorOutage } = ComponentStatuses;
  const base = { manual: operational, impacts: [], inMaintenance: false };

  it('maps down and recovering to the link impact, degraded to degraded, and the rest to nothing', () => {
    const link = (state: (typeof MonitorStates)[keyof typeof MonitorStates]) => [
      { state, impactWhenDown: ComponentImpacts.partialOutage },
    ];
    expect(deriveComponentStatus({ ...base, monitors: link(MonitorStates.down) })).toBe(partialOutage);
    expect(deriveComponentStatus({ ...base, monitors: link(MonitorStates.recovering) })).toBe(partialOutage);
    expect(deriveComponentStatus({ ...base, monitors: link(MonitorStates.degraded) })).toBe(degraded);
    const quiet = [MonitorStates.up, MonitorStates.suspect, MonitorStates.pending, MonitorStates.paused];
    expect(quiet.map(state => deriveComponentStatus({ ...base, monitors: link(state) }))).toEqual(
      quiet.map(() => operational),
    );
  });

  it('shows the worst of monitors, incidents, maintenance and the manual status', () => {
    const down = { state: MonitorStates.down, impactWhenDown: ComponentImpacts.majorOutage };
    const slow = { state: MonitorStates.degraded, impactWhenDown: ComponentImpacts.majorOutage };
    expect(deriveComponentStatus({ ...base, inMaintenance: true, monitors: [slow] })).toBe(degraded);
    expect(deriveComponentStatus({ ...base, impacts: [partialOutage], monitors: [down] })).toBe(majorOutage);
    expect(deriveComponentStatus({ ...base, impacts: [majorOutage], monitors: [slow] })).toBe(majorOutage);
    expect(deriveComponentStatus({ ...base, manual: partialOutage, monitors: [slow] })).toBe(partialOutage);
    expect(deriveComponentStatus({ ...base, inMaintenance: true, monitors: [] })).toBe(maintenance);
  });
});

describe('monitor state changes: component status, incidents and alerts (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let scope: StatusScope;
  let actor: string;
  let clock: Date;
  let fra: ProbeLocation;
  let bus: EventBus;

  const later = (seconds: number) => new Date(clock.getTime() + seconds * 1000);

  const current = async (monitorId: string) =>
    expectOne(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, monitorId)));

  /** Move the clock just past the monitor's next round and report `outcome` for it from fra. */
  const state = async (monitorId: string) => {
    const monitor = await current(monitorId);
    return monitor.state;
  };

  const round = async (monitorId: string, outcome: ReportedOutcome, latencyMs = 100) => {
    const due = await current(monitorId);
    clock = new Date(due.nextRoundAt.getTime() + 1000);
    const { leases } = await status.statusProbes.lease(fra, { agentVersion: '1', capacity: 10 });
    await status.statusProbes.report(
      fra,
      leases.map(lease => ({
        leaseId: lease.leaseId,
        monitorId: lease.monitorId,
        roundAt: lease.roundAt,
        outcome,
        latencyMs,
      })),
    );
    return await state(monitorId);
  };

  /** Let the monitor's next round pass its deadline with no report: an `unknown` verdict. */
  const silentRound = async (monitorId: string) => {
    const due = await current(monitorId);
    clock = new Date(due.nextRoundAt.getTime() + 30_000);
    await status.statusVerdicts.evaluate();
    return await state(monitorId);
  };

  const alerts = async () => {
    const rows = await t.db.select().from(domainEvents).orderBy(domainEvents.seq);
    return rows.map(row => row.type);
  };

  /** A page with two components and a monitor on both. */
  const setUp = async (extra: Partial<MonitorInput> = {}) => {
    const page = await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    const api = await status.statusPages.createComponent(scope, page.id, { name: 'API' });
    const web = await status.statusPages.createComponent(scope, page.id, { name: 'Dashboard' });
    const monitor = await status.statusMonitors.create(
      scope,
      actor,
      monitorInputSchema.parse({
        name: 'API health',
        spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health', latencyThresholdMs: 500 },
        locationIds: [fra.id],
        components: [
          { componentId: api.id, impactWhenDown: ComponentImpacts.majorOutage },
          { componentId: web.id, impactWhenDown: ComponentImpacts.partialOutage },
        ],
        ...extra,
      }),
    );
    return { page, api, web, monitor };
  };

  const displayed = async (pageId: string) => {
    const { components } = await status.statusPages.getPage(scope, pageId);
    return components.map(component => component.displayedStatus);
  };

  const incidents = async () => await t.db.select().from(statusIncidents).orderBy(statusIncidents.startedAt);

  /** The public snapshot the page would publish now. */
  const publicSnapshot = async (pageId: string) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mocco-status-'));
    const snapshots = createSnapshotService(t.db, {
      store: new FilesystemObjectStore({
        root,
        baseUrl: 'https://mocco.test/api/ext/internal/storage',
        signer: new StorageUrlSigner('test-signing-key'),
      }),
      queue: { enqueue: async () => await Promise.reject(new Error('unused')), kick: () => {} },
      now: () => clock,
    });
    const row = expectOne(await t.db.select().from(statusPages).where(eq(statusPages.id, pageId)));
    const snapshot = await snapshots?.build(row, 1, clock);
    await rm(root, { recursive: true, force: true });
    return snapshot;
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    bus = createTestEventBus(t.db, () => clock);
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
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
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

  it('alerts once per transition: none on suspect, repeats or unknown rounds, and recovery once', async () => {
    const { monitor } = await setUp({ incidentPolicy: IncidentPolicies.none });

    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.suspect);
    expect(await alerts()).toEqual([]);
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);
    expect(await silentRound(monitor.id)).toBe(MonitorStates.down);
    expect(await alerts()).toEqual([StatusEventTypes.statusMonitorDown]);
    expect(await round(monitor.id, CheckOutcomes.ok)).toBe(MonitorStates.recovering);
    expect(await round(monitor.id, CheckOutcomes.ok)).toBe(MonitorStates.up);
    expect(await round(monitor.id, CheckOutcomes.ok)).toBe(MonitorStates.up);

    expect(await alerts()).toEqual([StatusEventTypes.statusMonitorDown, StatusEventTypes.statusMonitorRecovered]);
    const changes = await t.db.select().from(statusMonitorStateChanges).orderBy(statusMonitorStateChanges.at);
    const down = changes.find(change => change.toState === MonitorStates.down);
    const event = expectOne(
      await t.db.select().from(domainEvents).where(eq(domainEvents.type, StatusEventTypes.statusMonitorDown)),
    );
    expect(event).toMatchObject({
      dedupeKey: `${StatusEventTypes.statusMonitorDown}:${down?.id}`,
      projectId: scope.projectId,
      payload: {
        facts: { monitor: 'API health', state: MonitorStates.down, duringMaintenance: false },
        message: {
          title: 'Down: API health',
          severity: 'error',
          url: `${APP_ORIGIN}/workspaces/${scope.workspaceId}/p/${scope.projectId}/status`,
        },
      },
    });

    expect(await incidents()).toEqual([]);

    // Reacting to the same change again (a retried reaction) publishes nothing new.
    if (down === undefined) {
      throw new Error('no down change');
    }
    const transitions = new MonitorTransitionService({
      db: t.db,
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      snapshots: new SnapshotScheduler({ db: t.db, queue: undefined, now: () => clock }),
      events: bus,
      now: () => clock,
    });
    await transitions.react(await current(monitor.id), down);
    expect(await alerts()).toHaveLength(2);
  });

  it('alerts on degraded and on its recovery, without opening an incident', async () => {
    const { monitor } = await setUp();

    expect(await round(monitor.id, CheckOutcomes.ok, 900)).toBe(MonitorStates.degraded);
    expect(await round(monitor.id, CheckOutcomes.ok, 900)).toBe(MonitorStates.degraded);
    expect(await round(monitor.id, CheckOutcomes.ok, 100)).toBe(MonitorStates.up);

    expect(await alerts()).toEqual([StatusEventTypes.statusMonitorDegraded, StatusEventTypes.statusMonitorRecovered]);
    expect(await incidents()).toEqual([]);
  });

  it('derives component status from the monitor and marks the page dirty only when it shows', async () => {
    const { page, monitor } = await setUp({ incidentPolicy: IncidentPolicies.none });
    const dirtyAt = async () =>
      expectOne(await t.db.select().from(statusPages).where(eq(statusPages.id, page.id))).dirtyAt;
    const before = await dirtyAt();

    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.suspect);
    expect(await dirtyAt()).toEqual(before);
    expect(await displayed(page.id)).toEqual([ComponentStatuses.operational, ComponentStatuses.operational]);

    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);
    const downAt = clock;
    expect(await dirtyAt()).toEqual(downAt);
    expect(await displayed(page.id)).toEqual([ComponentStatuses.majorOutage, ComponentStatuses.partialOutage]);

    // Recovering still shows the outage, so the page isn't rebuilt.
    expect(await round(monitor.id, CheckOutcomes.ok)).toBe(MonitorStates.recovering);
    expect(await dirtyAt()).toEqual(downAt);
    expect(await round(monitor.id, CheckOutcomes.ok, 900)).toBe(MonitorStates.degraded);
    expect(await dirtyAt()).toEqual(clock);
    expect(await displayed(page.id)).toEqual([ComponentStatuses.degraded, ComponentStatuses.degraded]);
  });

  it('shows a monitor outage over maintenance, and labels its alert', async () => {
    const { page, web, monitor } = await setUp({ incidentPolicy: IncidentPolicies.publish });
    await status.statusMaintenances.schedule(scope, actor, {
      pageId: page.id,
      title: 'Database upgrade',
      body: '',
      scheduledStart: T0,
      scheduledEnd: later(3600),
      componentIds: [web.id],
    });
    await status.statusMaintenances.tick(T0);
    expect(await displayed(page.id)).toEqual([ComponentStatuses.operational, ComponentStatuses.maintenance]);

    await round(monitor.id, CheckOutcomes.fail);
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);

    expect(await displayed(page.id)).toEqual([ComponentStatuses.majorOutage, ComponentStatuses.partialOutage]);
    // `publish` is held back as a draft while a window covers the monitor's components.
    const incident = expectOne(await incidents());
    expect(incident.visibility).toBe(IncidentVisibilities.draft);
    const event = expectOne(await t.db.select().from(domainEvents));
    expect(event.payload).toMatchObject({
      facts: { duringMaintenance: true },
      message: {
        title: 'Down: API health (during maintenance)',
        url: `${APP_ORIGIN}/workspaces/${scope.workspaceId}/p/${scope.projectId}/status/incidents/${incident.id}`,
        fields: expect.arrayContaining([{ name: 'Incident', value: 'Opened as a draft', inline: true }]),
      },
    });
  });

  it('keeps URL credentials, path and query out of alerts, events, audit, incidents and the public page', async () => {
    // A bus with the real fan-out, so the alert goes through the notification template to a Discord embed.
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => clock,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    bus = createEventBus({ db: t.db, queue, now: () => clock, appOrigin: APP_ORIGIN });
    status = createStatusDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      events: bus,
      appOrigin: APP_ORIGIN,
      now: () => clock,
    });
    const channel = await seedChannel(t.db, scope.workspaceId);
    await seedRule(t.db, channel, { eventType: 'status.*' });
    const secrets = ['probe-user', 'hunter2', '/v1/health', 's3cret-token', 'api_key', 'k3y-value', 'frag'];
    const { page, monitor } = await setUp({
      incidentPolicy: IncidentPolicies.publish,
      spec: httpMonitorSpecSchema.parse({
        kind: MonitorKinds.http,
        url: 'https://probe-user:hunter2@api.acme.test:8443/v1/health?token=s3cret-token&api_key=k3y-value#frag',
      }),
    });
    await round(monitor.id, CheckOutcomes.fail);
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);
    const down = expectOne(
      await t.db.select().from(domainEvents).where(eq(domainEvents.type, StatusEventTypes.statusMonitorDown)),
    );
    await bus.deliver(down.id, NotificationSubscribers.status.name);

    const delivery = expectOne(
      await t.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, down.id)),
    );
    const embed = renderEmbed(delivery.message, clock);
    expect(embed.fields).toContainEqual({ name: 'Checks', value: 'api.acme.test:8443', inline: false });
    const events = await t.db.select().from(domainEvents);
    const audits = await t.db.select().from(auditLog);
    const opened = await incidents();
    const updates = await t.db.select().from(statusIncidentUpdates);
    const outbound = {
      embed,
      events: events.map(event => event.payload),
      audits: audits.map(entry => entry.payload),
      incidents: opened.map(incident => incident.title),
      updates: updates.map(update => update.bodyMd),
      snapshot: await publicSnapshot(page.id),
    };
    expect(outbound.snapshot?.incidents).toHaveLength(1);
    const text = JSON.stringify(outbound);
    expect(secrets.filter(secret => text.includes(secret))).toEqual([]);
  });

  it('opens one draft incident on down, follows the recovery, and opens a new one next time', async () => {
    const { page, api, web, monitor } = await setUp();

    await round(monitor.id, CheckOutcomes.fail);
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);

    const opened = expectOne(await incidents());
    expect(opened).toMatchObject({
      pageId: page.id,
      title: 'API health is down',
      status: IncidentStatuses.investigating,
      visibility: IncidentVisibilities.draft,
      severity: IncidentSeverities.major,
      createdByUserId: null,
    });
    const { components, updates } = await status.statusIncidents.get(scope, opened.id);
    expect(new Map(components.map(row => [row.componentId, row.impact]))).toEqual(
      new Map([
        [api.id, ComponentImpacts.majorOutage],
        [web.id, ComponentImpacts.partialOutage],
      ]),
    );
    expect(updates.map(update => [update.status, update.authorUserId])).toEqual([
      [IncidentStatuses.investigating, null],
    ]);

    expect(await round(monitor.id, CheckOutcomes.ok)).toBe(MonitorStates.recovering);
    expect(expectOne(await incidents()).status).toBe(IncidentStatuses.monitoring);
    // Failing again while recovering moves it back.
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);
    expect(expectOne(await incidents()).status).toBe(IncidentStatuses.identified);
    await round(monitor.id, CheckOutcomes.ok);
    expect(await round(monitor.id, CheckOutcomes.ok)).toBe(MonitorStates.up);

    const resolved = expectOne(await incidents());
    expect(resolved).toMatchObject({ status: IncidentStatuses.resolved, resolvedAt: clock });
    const timeline = await t.db
      .select()
      .from(statusIncidentUpdates)
      .where(eq(statusIncidentUpdates.incidentId, opened.id))
      .orderBy(statusIncidentUpdates.createdAt);
    expect(timeline.map(update => update.status)).toEqual([
      IncidentStatuses.investigating,
      IncidentStatuses.monitoring,
      IncidentStatuses.identified,
      IncidentStatuses.monitoring,
      IncidentStatuses.resolved,
    ]);
    expect(expectOne(await t.db.select().from(statusIncidentMonitors)).closedAt).toEqual(clock);

    // Audited as the system: no actor.
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.subjectId, opened.id)).orderBy(auditLog.seq);
    expect(audits.map(row => [row.action, row.actorUserId])).toEqual([
      [AuditActions.statusIncidentCreated, null],
      [AuditActions.statusIncidentUpdated, null],
      [AuditActions.statusIncidentUpdated, null],
      [AuditActions.statusIncidentUpdated, null],
      [AuditActions.statusIncidentUpdated, null],
    ]);

    await round(monitor.id, CheckOutcomes.fail);
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);
    expect(await incidents()).toHaveLength(2);
  });

  it('publishes with policy publish, and opens a new incident when the last was resolved by hand', async () => {
    const { monitor } = await setUp({ incidentPolicy: IncidentPolicies.publish });
    await round(monitor.id, CheckOutcomes.fail);
    await round(monitor.id, CheckOutcomes.fail);
    const first = expectOne(await incidents());
    expect(first.visibility).toBe(IncidentVisibilities.published);
    await status.statusIncidents.postUpdate(scope, actor, first.id, {
      status: IncidentStatuses.resolved,
      body: 'Fixed',
    });

    await round(monitor.id, CheckOutcomes.ok);
    await round(monitor.id, CheckOutcomes.ok);
    await round(monitor.id, CheckOutcomes.fail);
    expect(await round(monitor.id, CheckOutcomes.fail)).toBe(MonitorStates.down);
    expect(await incidents()).toHaveLength(2);
  });

  it('keeps a draft monitor incident out of the public snapshot', async () => {
    const { page, monitor } = await setUp();
    await round(monitor.id, CheckOutcomes.fail);
    await round(monitor.id, CheckOutcomes.fail);
    expect(expectOne(await incidents()).visibility).toBe(IncidentVisibilities.draft);

    const snapshot = await publicSnapshot(page.id);

    expect(snapshot).toMatchObject({ incidents: [], history: [] });
    expect(JSON.stringify(snapshot)).not.toContain('API health is down');
    // The monitor itself still shows on the public components.
    expect(snapshot?.status).toBe(ComponentStatuses.majorOutage);
    expect(snapshot?.sections.flatMap(section => section.components.map(component => component.status))).toEqual([
      ComponentStatuses.majorOutage,
      ComponentStatuses.partialOutage,
    ]);
  });

  it('suggests the release before a monitor incident opens', async () => {
    const repoId = await seedRepo(t.db, scope.workspaceId, 'api', [scope.projectId]);
    const runId = await seedRelease(t.db, {
      workspaceId: scope.workspaceId,
      repoId,
      projectIds: [scope.projectId],
      releasedAt: new Date(T0.getTime() - 60_000),
    });
    const { monitor } = await setUp();
    await round(monitor.id, CheckOutcomes.fail);
    await round(monitor.id, CheckOutcomes.fail);

    const incident = expectOne(await incidents());
    expect(await status.statusCorrelation.list(scope, incident.id)).toEqual([
      expect.objectContaining({ runId, relation: IncidentRunRelations.suspected, linkedByUserId: null }),
    ]);
  });
});
