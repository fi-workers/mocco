import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ComponentStatuses, IncidentSeverities, IncidentStatuses, MaintenanceStatuses } from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { deriveComponentStatus } from '@backend/domain/status/component-status';
import { createStatusDomain } from '@backend/domain/status/compose';
import {
  IncidentTransitionError,
  MaintenanceTransitionError,
  StatusEntityNotFoundError,
} from '@backend/domain/status/errors';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, statusIncidents, statusMaintenances, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('deriveComponentStatus', () => {
  it('shows the worst of the manual status, open incident impacts and maintenance', () => {
    const { operational, maintenance, degraded, partialOutage, majorOutage } = ComponentStatuses;
    expect(deriveComponentStatus({ manual: operational, impacts: [], inMaintenance: false })).toBe(operational);
    expect(deriveComponentStatus({ manual: operational, impacts: [], inMaintenance: true })).toBe(maintenance);
    expect(deriveComponentStatus({ manual: degraded, impacts: [], inMaintenance: true })).toBe(degraded);
    expect(deriveComponentStatus({ manual: operational, impacts: [degraded, majorOutage], inMaintenance: false })).toBe(
      majorOutage,
    );
    expect(deriveComponentStatus({ manual: majorOutage, impacts: [partialOutage], inMaintenance: true })).toBe(
      majorOutage,
    );
  });
});

describe('incidents and maintenance (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let scope: StatusScope;
  let actor: string;
  let clock: Date;

  const actions = async () => {
    const rows = await t.db.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.seq);
    return rows.map(row => row.action);
  };

  /** Each window's status, actual start and actual end, by title. */
  const windowStates = async () => {
    const rows = await t.db.select().from(statusMaintenances);
    return Object.fromEntries(rows.map(row => [row.title, [row.status, row.actualStart, row.actualEnd]]));
  };

  /** A page with two components. */
  const setUp = async () => {
    const page = await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    const api = await status.statusPages.createComponent(scope, page.id, { name: 'API' });
    const web = await status.statusPages.createComponent(scope, page.id, { name: 'Dashboard' });
    return { page, api, web };
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    status = createStatusDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), now: () => clock });
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
  });
  afterEach(async () => {
    await t.close();
  });

  it('moves an incident forward, sets resolved_at only when resolved, and closes it', async () => {
    const { page, api } = await setUp();
    const incident = await status.statusIncidents.create(scope, actor, {
      pageId: page.id,
      title: 'Elevated errors',
      severity: IncidentSeverities.major,
      status: IncidentStatuses.investigating,
      body: 'Looking into it',
      components: [{ componentId: api.id, impact: ComponentStatuses.partialOutage }],
    });
    expect(incident).toMatchObject({ status: IncidentStatuses.investigating, resolvedAt: null, identifiedAt: null });

    clock = minutes(5);
    const identified = await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.identified,
      body: 'A bad deploy',
    });
    clock = minutes(10);
    await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.monitoring,
      body: 'Rolled back',
    });
    // The fix didn't hold: monitoring may go back to identified, keeping the first identified_at.
    const back = await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.identified,
      body: 'Still failing',
    });
    clock = minutes(20);
    const resolved = await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.resolved,
      body: 'All good',
    });

    expect(identified.incident).toMatchObject({ identifiedAt: minutes(5), resolvedAt: null });
    expect(back.incident).toMatchObject({ identifiedAt: minutes(5), resolvedAt: null });
    expect(resolved.incident).toMatchObject({ status: IncidentStatuses.resolved, resolvedAt: minutes(20) });
    const detail = await status.statusIncidents.get(scope, incident.id);
    expect(detail.updates.map(update => update.status)).toEqual([
      IncidentStatuses.investigating,
      IncidentStatuses.identified,
      IncidentStatuses.monitoring,
      IncidentStatuses.identified,
      IncidentStatuses.resolved,
    ]);
    expect(detail.components).toEqual([expect.objectContaining({ componentId: api.id, impact: 'partial_outage' })]);
    await expect(
      status.statusIncidents.postUpdate(scope, actor, incident.id, { status: IncidentStatuses.resolved, body: 'x' }),
    ).rejects.toBeInstanceOf(IncidentTransitionError);
    await expect(
      status.statusIncidents.postUpdate(scope, actor, incident.id, { status: IncidentStatuses.monitoring, body: 'x' }),
    ).rejects.toBeInstanceOf(IncidentTransitionError);
  });

  it('rejects backward transitions and leaves the incident untouched', async () => {
    const { page } = await setUp();
    const incident = await status.statusIncidents.create(scope, actor, {
      pageId: page.id,
      title: 'Slow',
      severity: IncidentSeverities.minor,
      status: IncidentStatuses.identified,
      body: 'Known cause',
      components: [],
    });

    await expect(
      status.statusIncidents.postUpdate(scope, actor, incident.id, {
        status: IncidentStatuses.investigating,
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(IncidentTransitionError);
    const sameStatus = await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.identified,
      body: 'Still working on it',
    });

    const detail = await status.statusIncidents.get(scope, incident.id);
    expect(sameStatus.incident.identifiedAt).toEqual(T0);
    expect(detail.updates).toHaveLength(2);
  });

  it('enforces the resolved_at invariant in the database too', async () => {
    const { page } = await setUp();
    const incident = await status.statusIncidents.create(scope, actor, {
      pageId: page.id,
      title: 'Down',
      severity: IncidentSeverities.critical,
      status: IncidentStatuses.investigating,
      body: 'Down',
      components: [],
    });

    await expect(
      t.db
        .update(statusIncidents)
        .set({ status: IncidentStatuses.resolved })
        .where(eq(statusIncidents.id, incident.id)),
    ).rejects.toThrow();
    await expect(
      t.db.update(statusIncidents).set({ resolvedAt: T0 }).where(eq(statusIncidents.id, incident.id)),
    ).rejects.toThrow();
  });

  it('only lets an incident affect components on its own page', async () => {
    const { page } = await setUp();
    const second = await status.statusPages.createPage(scope, actor, { slug: 'second', title: 'Second' });
    const elsewhere = await status.statusPages.createComponent(scope, second.id, { name: 'Elsewhere' });

    await expect(
      status.statusIncidents.create(scope, actor, {
        pageId: page.id,
        title: 'x',
        severity: IncidentSeverities.minor,
        status: IncidentStatuses.investigating,
        body: 'x',
        components: [{ componentId: elsewhere.id, impact: ComponentStatuses.degraded }],
      }),
    ).rejects.toBeInstanceOf(StatusEntityNotFoundError);
    expect(await status.statusIncidents.list(scope, page.id, false)).toEqual([]);
  });

  it('derives what components show from open incidents and maintenance in progress', async () => {
    const { page, api, web } = await setUp();
    const shown = async () => {
      const { components } = await status.statusPages.getPage(scope, page.id);
      return Object.fromEntries(components.map(row => [row.name, row.displayedStatus]));
    };
    const incident = await status.statusIncidents.create(scope, actor, {
      pageId: page.id,
      title: 'Errors',
      severity: IncidentSeverities.major,
      status: IncidentStatuses.investigating,
      body: 'x',
      components: [{ componentId: api.id, impact: ComponentStatuses.majorOutage }],
    });
    await status.statusMaintenances.schedule(scope, actor, {
      pageId: page.id,
      title: 'Database upgrade',
      body: '',
      scheduledStart: minutes(-1),
      scheduledEnd: minutes(30),
      componentIds: [api.id, web.id],
    });
    await status.statusMaintenances.tick(T0);

    expect(await shown()).toEqual({ API: 'major_outage', Dashboard: 'maintenance' });
    await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.resolved,
      body: 'Fixed',
    });
    await status.statusPages.setComponentStatus(scope, actor, web.id, ComponentStatuses.degraded);
    expect(await shown()).toEqual({ API: 'maintenance', Dashboard: 'degraded' });
    await status.statusMaintenances.tick(minutes(30));
    expect(await shown()).toEqual({ API: 'operational', Dashboard: 'degraded' });
  });

  it('starts and completes maintenance windows on the tick, and cancels only open ones', async () => {
    const { page, api } = await setUp();
    const window = async (start: number, end: number, title: string) =>
      await status.statusMaintenances.schedule(scope, actor, {
        pageId: page.id,
        title,
        body: '',
        scheduledStart: minutes(start),
        scheduledEnd: minutes(end),
        componentIds: [api.id],
      });
    const soon = await window(10, 40, 'soon');
    const missed = await window(1, 5, 'missed');
    const canceled = await window(60, 90, 'canceled');

    expect(await status.statusMaintenances.tick(minutes(9))).toEqual({ started: 0, completed: 1 });
    expect(await status.statusMaintenances.tick(minutes(10))).toEqual({ started: 1, completed: 0 });
    expect(await status.statusMaintenances.tick(minutes(11))).toEqual({ started: 0, completed: 0 });
    await status.statusMaintenances.cancel(scope, actor, canceled.id);
    expect(await status.statusMaintenances.tick(minutes(61))).toEqual({ started: 0, completed: 1 });

    expect(await windowStates()).toEqual({
      soon: [MaintenanceStatuses.completed, minutes(10), minutes(61)],
      missed: [MaintenanceStatuses.completed, minutes(9), minutes(9)],
      canceled: [MaintenanceStatuses.canceled, null, null],
    });
    await expect(status.statusMaintenances.cancel(scope, actor, soon.id)).rejects.toBeInstanceOf(
      MaintenanceTransitionError,
    );
    await expect(status.statusMaintenances.cancel(scope, actor, missed.id)).rejects.toBeInstanceOf(
      MaintenanceTransitionError,
    );
    const listed = await status.statusMaintenances.list(scope, page.id);
    expect(listed.map(row => [row.title, row.componentIds])).toEqual([
      ['canceled', [api.id]],
      ['soon', [api.id]],
      ['missed', [api.id]],
    ]);
  });

  it('appends every incident, maintenance and manual status change to the audit log', async () => {
    const { page, api } = await setUp();
    const incident = await status.statusIncidents.create(scope, actor, {
      pageId: page.id,
      title: 'Errors',
      severity: IncidentSeverities.minor,
      status: IncidentStatuses.investigating,
      body: 'x',
      components: [],
    });
    await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.resolved,
      body: 'y',
    });
    await status.statusIncidents.setComponents(scope, actor, incident.id, [
      { componentId: api.id, impact: ComponentStatuses.degraded },
    ]);
    await status.statusIncidents.setPostmortem(scope, actor, incident.id, '## What happened');
    const maintenance = await status.statusMaintenances.schedule(scope, actor, {
      pageId: page.id,
      title: 'Upgrade',
      body: '',
      scheduledStart: minutes(1),
      scheduledEnd: minutes(2),
      componentIds: [],
    });
    await status.statusMaintenances.tick(minutes(1));
    await status.statusMaintenances.tick(minutes(2));
    await status.statusPages.setComponentStatus(scope, actor, api.id, ComponentStatuses.degraded);
    const later = await status.statusMaintenances.schedule(scope, actor, {
      pageId: page.id,
      title: 'Later',
      body: '',
      scheduledStart: minutes(100),
      scheduledEnd: minutes(200),
      componentIds: [],
    });
    await status.statusMaintenances.cancel(scope, actor, later.id);

    expect(await actions()).toEqual([
      AuditActions.statusPageCreated,
      AuditActions.statusIncidentCreated,
      AuditActions.statusIncidentUpdated,
      AuditActions.statusIncidentComponentsChanged,
      AuditActions.statusIncidentPostmortemChanged,
      AuditActions.statusMaintenanceScheduled,
      AuditActions.statusMaintenanceStarted,
      AuditActions.statusMaintenanceCompleted,
      AuditActions.statusComponentStatusChanged,
      AuditActions.statusMaintenanceScheduled,
      AuditActions.statusMaintenanceCanceled,
    ]);
    const updated = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.statusIncidentUpdated));
    expect(updated[0]).toMatchObject({
      actorUserId: actor,
      subjectType: 'status_incident',
      subjectId: incident.id,
      payload: expect.objectContaining({ from: 'investigating', to: 'resolved' }),
    });
    const started = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditActions.statusMaintenanceStarted));
    expect(started[0]).toMatchObject({ actorUserId: null, subjectId: maintenance.id });
  });

  it('runs the maintenance tick as a scheduled job', async () => {
    const { page } = await setUp();
    const maintenance = await status.statusMaintenances.schedule(scope, actor, {
      pageId: page.id,
      title: 'Upgrade',
      body: '',
      scheduledStart: minutes(-1),
      scheduledEnd: minutes(30),
      componentIds: [],
    });
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: () => {},
      appOrigin: 'https://mocco.test',
      discord: undefined,
      storage: undefined,
    });

    const report = await runner.tick({ budgetMs: 10_000, maxJobs: 50 });

    expect(report.errors).toEqual([]);
    const [row] = await t.db.select().from(statusMaintenances).where(eq(statusMaintenances.id, maintenance.id));
    expect(row).toMatchObject({ status: MaintenanceStatuses.inProgress, actualStart: T0 });
  });
});
