// Scheduled maintenance on a status page (#148). An operator schedules or cancels a window;
// the maintenance tick (every minute) starts it and completes it. While a window is in
// progress, the components it covers show `maintenance` unless an incident is worse.
//
// Gate-linked maintenance (#158): a page can name a gate that announces maintenance. When a run
// of a repository linked to the page's project resumes a gate with that name (`gate.resumed`), a
// window starts on the page for the run; it completes when the run finishes, however it ends
// (`run.succeeded`, `run.failed`, `gate.rejected`, or a canceled run the tick finds). One still in
// progress after its expected minutes is flagged as overrun once, with an alert.
import { AuditActions } from '@mocco/common/audit';
import { StatusEventTypes } from '@mocco/common/events';
import { FINISHED_RUN_STATES, RunStates } from '@mocco/common/execution';
import { Severities } from '@mocco/common/notification';
import { MaintenanceStatuses, SubscriberMailKinds } from '@mocco/common/status';

import { publishBestEffort } from '@backend/domain/events/ports';
import {
  MaintenanceTransitionError,
  MaintenanceWindowError,
  StatusEntityNotFoundError,
} from '@backend/domain/status/errors';
import { ComponentRepo } from '@backend/domain/status/repos/component.repo';
import { GateMaintenanceRepo } from '@backend/domain/status/repos/gate-maintenance.repo';
import { MaintenanceComponentRepo } from '@backend/domain/status/repos/maintenance-component.repo';
import { MaintenanceRepo } from '@backend/domain/status/repos/maintenance.repo';
import { actorOf } from '@backend/domain/status/scope';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { PublishInput } from '@backend/domain/events/EventBus';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { SubscriberNotice } from '@backend/domain/status/jobs';
import type { RunSource } from '@backend/domain/status/ports';
import type { MaintenanceRow } from '@backend/domain/status/repos/maintenance.repo';
import type { StatusActor, StatusScope } from '@backend/domain/status/scope';
import type { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { SubscriberNotices } from '@backend/domain/status/SubscriberNotices';
import type { Db } from '@backend/infra/db/types';
import type { AuditAction } from '@mocco/common/audit';
import type { RunState } from '@mocco/common/execution';
import type { GateMaintenanceInput, MaintenanceInput, MaintenanceStatus } from '@mocco/common/status';

export interface MaintenanceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  pages: Pick<StatusPageService, 'requirePage'>;
  /** Marks the public page dirty with each change and requests a publish. */
  snapshots: Pick<SnapshotScheduler, 'change'>;
  /** The runs gate-linked windows last for. */
  runs: RunSource;
  /** Where overrun alerts are published; without it there are none. */
  events?: EventPublisher;
  /** The app's origin, for the link in an overrun alert. */
  appOrigin?: string;
  /** Asks for the subscriber fan-out of each window change, in its transaction. */
  notices?: Pick<SubscriberNotices, 'request'>;
  now?: () => Date;
}

/** A gate that was resumed, from its `gate.resumed` event. */
export interface ResumedGate {
  workspaceId: string;
  runId: string;
  gateId: string;
  gateName: string;
}

const MINUTE_MS = 60_000;

/** Why a run-linked window ended early, by how its run ended; a run that succeeded needs no note. */
export const MAINTENANCE_END_NOTES: Partial<Record<RunState, string>> = {
  [RunStates.failed]: 'Ended when the run failed.',
  [RunStates.canceled]: 'Ended when the run was canceled.',
  [RunStates.rejected]: 'Ended when a later gate rejected the run.',
};

const subject = (maintenanceId: string) => ({ subjectType: 'status_maintenance', subjectId: maintenanceId });

/** The subscriber notice of a window moving to `status`. */
const noticeOf = (row: MaintenanceRow, status: MaintenanceStatus): SubscriberNotice => ({
  kind: SubscriberMailKinds.maintenance,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  maintenanceId: row.id,
  status,
});

const minutesOf = (row: MaintenanceRow) =>
  Math.round((row.scheduledEnd.getTime() - row.scheduledStart.getTime()) / MINUTE_MS);

export class MaintenanceService {
  constructor(private readonly deps: MaintenanceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Audit system transitions (no actor), one at a time: each append extends a workspace's hash chain. */
  private async recordSystem(
    rows: readonly MaintenanceRow[],
    action: AuditAction,
    extra: (row: MaintenanceRow) => Record<string, unknown> = () => ({}),
  ): Promise<void> {
    await rows.reduce(async (previous, row) => {
      await previous;
      await this.deps.audit.record(row.workspaceId, {
        actorUserId: null,
        action,
        ...subject(row.id),
        payload: { pageId: row.pageId, projectId: row.projectId, ...extra(row) },
      });
    }, Promise.resolve());
  }

  /** Throw for the first of `componentIds` that isn't a component of the page. */
  private async requireComponents(scope: StatusScope, pageId: string, componentIds: readonly string[]) {
    const found = new Set(await new ComponentRepo(this.deps.db).idsOnPage(scope, pageId, componentIds));
    const missing = componentIds.find(id => !found.has(id));
    if (missing !== undefined) {
      throw new StatusEntityNotFoundError('component', missing);
    }
  }

  /** Complete the run-linked windows whose run finished without the event saying so (a canceled
   * run publishes none, and an event can be lost). */
  private async completeFinishedRuns(now: Date): Promise<number> {
    const windows = await new MaintenanceRepo(this.deps.db).listRunLinkedInProgress();
    const workspaceIds = [...new Set(windows.map(window => window.workspaceId))];
    return await workspaceIds.reduce(async (previous, workspaceId) => {
      const count = await previous;
      const runIds = windows.flatMap(window =>
        window.workspaceId === workspaceId && window.runId !== null ? [window.runId] : [],
      );
      const runs = await this.deps.runs.runs(workspaceId, [...new Set(runIds)]);
      const finished = runs.filter(run => FINISHED_RUN_STATES.has(run.state));
      return await finished.reduce(async (inner, run) => {
        const sum = await inner;
        const { completed } = await this.completeForRun({ workspaceId, runId: run.runId, state: run.state }, now);
        return sum + completed;
      }, Promise.resolve(count));
    }, Promise.resolve(0));
  }

  /** Alert that a run-linked window is still in progress after its expected minutes. */
  private async alertOverrun(row: MaintenanceRow): Promise<void> {
    const { events, appOrigin } = this.deps;
    if (events === undefined) {
      return;
    }
    const type = StatusEventTypes.statusMaintenanceOverran;
    const path = `/workspaces/${row.workspaceId}/p/${row.projectId}/status?page=${row.pageId}&tab=maintenance`;
    const input: PublishInput = {
      type,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      subject: { type: 'status_maintenance', id: row.id },
      dedupeKey: `${type}:${row.id}`,
      ...(row.overranAt !== null && { occurredAt: row.overranAt }),
      payload: {
        facts: { maintenance: row.title },
        message: {
          title: `Maintenance overran: ${row.title}`.slice(0, 256),
          ...(appOrigin !== undefined && { url: `${appOrigin}${path}` }),
          description: `Expected to take ${minutesOf(row)} min. The run is still going, so the window stays open until it finishes.`,
          severity: Severities.warning,
          fields: [],
          footer: 'Mocco status',
        },
      },
    };
    await publishBestEffort(events, type, async () => await Promise.resolve(input));
  }

  /** A page's windows, latest start first, each with the components it covers. */
  async list(scope: StatusScope, pageId: string) {
    await this.deps.pages.requirePage(scope, pageId);
    const windows = await new MaintenanceRepo(this.deps.db).listForPage(scope, pageId);
    const links = await new MaintenanceComponentRepo(this.deps.db).listFor(
      scope.workspaceId,
      windows.map(window => window.id),
    );
    return windows.map(window => ({
      ...window,
      componentIds: links.filter(link => link.maintenanceId === window.id).map(link => link.componentId),
    }));
  }

  async schedule(scope: StatusScope, actor: StatusActor, input: MaintenanceInput) {
    const { userId, via } = actorOf(actor);
    if (input.scheduledEnd <= input.scheduledStart) {
      throw new MaintenanceWindowError();
    }
    await this.deps.pages.requirePage(scope, input.pageId);
    await this.requireComponents(scope, input.pageId, input.componentIds);
    const maintenance = await this.deps.snapshots.change(async (tx, touch) => {
      touch({ workspaceId: scope.workspaceId, pageId: input.pageId });
      const created = await new MaintenanceRepo(tx).insert({
        ...scope,
        pageId: input.pageId,
        title: input.title,
        bodyMd: input.body,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        createdByUserId: userId,
      });
      await new MaintenanceComponentRepo(tx).insertMany(scope.workspaceId, created.id, input.componentIds);
      await this.deps.notices?.request(tx, [noticeOf(created, MaintenanceStatuses.scheduled)]);
      return created;
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusMaintenanceScheduled,
      ...subject(maintenance.id),
      payload: {
        pageId: input.pageId,
        title: input.title,
        scheduledStart: input.scheduledStart.toISOString(),
        scheduledEnd: input.scheduledEnd.toISOString(),
        componentIds: input.componentIds,
        ...via,
      },
    });
    return maintenance;
  }

  /** Cancel a window that hasn't completed; one in progress ends now. */
  async cancel(scope: StatusScope, actor: StatusActor, maintenanceId: string) {
    const { userId, via } = actorOf(actor);
    const now = this.now();
    const { maintenance, from } = await this.deps.snapshots.change(async (tx, touch) => {
      const windows = new MaintenanceRepo(tx);
      const current = await windows.findForUpdate(scope, maintenanceId);
      if (current === undefined) {
        throw new StatusEntityNotFoundError('maintenance', maintenanceId);
      }
      touch({ workspaceId: scope.workspaceId, pageId: current.pageId });
      if (current.status !== MaintenanceStatuses.scheduled && current.status !== MaintenanceStatuses.inProgress) {
        throw new MaintenanceTransitionError(current.status);
      }
      const canceled = await windows.update(scope, maintenanceId, {
        status: MaintenanceStatuses.canceled,
        ...(current.status === MaintenanceStatuses.inProgress && { actualEnd: now }),
      });
      await this.deps.notices?.request(tx, [noticeOf(current, MaintenanceStatuses.canceled)]);
      return { maintenance: canceled, from: current.status };
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusMaintenanceCanceled,
      ...subject(maintenanceId),
      payload: { from, ...via },
    });
    return maintenance;
  }

  /** The page's gates that announce maintenance, by gate name. */
  async listGateMaintenances(scope: StatusScope, pageId: string) {
    await this.deps.pages.requirePage(scope, pageId);
    return await new GateMaintenanceRepo(this.deps.db).listForPage(scope, pageId);
  }

  /** Make the gate announce maintenance on the page, or change what it announces. */
  async setGateMaintenance(scope: StatusScope, actor: StatusActor, input: GateMaintenanceInput) {
    const { userId, via } = actorOf(actor);
    await this.deps.pages.requirePage(scope, input.pageId);
    await this.requireComponents(scope, input.pageId, input.componentIds);
    const gateMaintenance = await new GateMaintenanceRepo(this.deps.db).upsert({
      ...scope,
      pageId: input.pageId,
      gateName: input.gateName,
      title: input.title,
      expectedMinutes: input.expectedMinutes,
      componentIds: [...new Set(input.componentIds)],
      createdByUserId: userId,
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusGateMaintenanceSet,
      subjectType: 'status_gate_maintenance',
      subjectId: gateMaintenance.id,
      payload: {
        pageId: input.pageId,
        gateName: input.gateName,
        title: input.title,
        expectedMinutes: input.expectedMinutes,
        componentIds: gateMaintenance.componentIds,
        ...via,
      },
    });
    return gateMaintenance;
  }

  /** Stop the gate announcing maintenance on the page; windows it already started go on. */
  async deleteGateMaintenance(scope: StatusScope, actor: StatusActor, gateMaintenanceId: string) {
    const { userId, via } = actorOf(actor);
    const deleted = await new GateMaintenanceRepo(this.deps.db).delete(scope, gateMaintenanceId);
    if (deleted === undefined) {
      throw new StatusEntityNotFoundError('gate maintenance', gateMaintenanceId);
    }
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusGateMaintenanceDeleted,
      subjectType: 'status_gate_maintenance',
      subjectId: deleted.id,
      payload: { pageId: deleted.pageId, gateName: deleted.gateName, ...via },
    });
  }

  /**
   * On `gate.resumed`: start a window on every page of the run's projects that names the gate,
   * expected to end after its minutes. A run that already finished starts none (its events can
   * be delivered in any order), and a redelivered event starts no second window on a page.
   */
  async startForGate(gate: ResumedGate): Promise<{ started: number }> {
    const now = this.now();
    const [run] = await this.deps.runs.runs(gate.workspaceId, [gate.runId]);
    if (run === undefined || FINISHED_RUN_STATES.has(run.state)) {
      return { started: 0 };
    }
    const announced = await new GateMaintenanceRepo(this.deps.db).listForGate(
      gate.workspaceId,
      run.projectIds,
      gate.gateName,
    );
    if (announced.length === 0) {
      return { started: 0 };
    }
    const started = await this.deps.snapshots.change(
      async (tx, touch) =>
        // One page at a time, in the transaction.
        await announced.reduce<Promise<MaintenanceRow[]>>(async (previous, rule) => {
          const rows = await previous;
          const scope = { workspaceId: rule.workspaceId, projectId: rule.projectId };
          const created = await new MaintenanceRepo(tx).insertForGate({
            ...scope,
            pageId: rule.pageId,
            title: rule.title,
            status: MaintenanceStatuses.inProgress,
            scheduledStart: now,
            scheduledEnd: new Date(now.getTime() + rule.expectedMinutes * MINUTE_MS),
            actualStart: now,
            runId: gate.runId,
            gateId: gate.gateId,
          });
          if (created === undefined) {
            return rows;
          }
          // Components deleted since the gate was set up are skipped.
          const componentIds = await new ComponentRepo(tx).idsOnPage(scope, rule.pageId, rule.componentIds);
          await new MaintenanceComponentRepo(tx).insertMany(scope.workspaceId, created.id, componentIds);
          await this.deps.notices?.request(tx, [noticeOf(created, MaintenanceStatuses.inProgress)]);
          touch({ workspaceId: scope.workspaceId, pageId: rule.pageId });
          return [...rows, created];
        }, Promise.resolve([])),
    );
    await this.recordSystem(started, AuditActions.statusMaintenanceStarted, row => ({
      runId: gate.runId,
      gateId: gate.gateId,
      gateName: gate.gateName,
      expectedMinutes: minutesOf(row),
    }));
    return { started: started.length };
  }

  /**
   * Complete the run's windows in progress, however it ended. One that didn't succeed gets a
   * note saying how it ended (`MAINTENANCE_END_NOTES`). A window already ended is left alone.
   */
  async completeForRun(
    run: { workspaceId: string; runId: string; state: RunState },
    now: Date = this.now(),
  ): Promise<{ completed: number }> {
    const endNote = MAINTENANCE_END_NOTES[run.state] ?? null;
    const completed = await this.deps.snapshots.change(async (tx, touch) => {
      const rows = await new MaintenanceRepo(tx).completeForRun(run.workspaceId, run.runId, { now, endNote });
      touch(...rows.map(row => ({ workspaceId: row.workspaceId, pageId: row.pageId })));
      await this.deps.notices?.request(
        tx,
        rows.map(row => noticeOf(row, MaintenanceStatuses.completed)),
      );
      return rows;
    });
    await this.recordSystem(completed, AuditActions.statusMaintenanceCompleted, () => ({
      runId: run.runId,
      runState: run.state,
      endNote,
    }));
    return { completed: completed.length };
  }

  /**
   * Move every workspace's windows along: complete the run-linked ones whose run finished, then
   * scheduled ones whose end has passed, start scheduled ones whose start has passed, and flag
   * run-linked ones past their expected end as overrun. Each transition is one conditional
   * UPDATE, so two overlapping ticks can't move a window twice. Runs as the
   * `status.maintenance.tick` job.
   */
  async tick(now: Date = this.now()): Promise<{ started: number; completed: number; overran: number }> {
    const runEnded = await this.completeFinishedRuns(now);
    const { completed, started, overran } = await this.deps.snapshots.change(async (tx, touch) => {
      const windows = new MaintenanceRepo(tx);
      const moved = {
        completed: await windows.completeDue(now),
        started: await windows.startDue(now),
        overran: await windows.flagOverrunDue(now),
      };
      touch(
        ...[...moved.completed, ...moved.started].map(row => ({ workspaceId: row.workspaceId, pageId: row.pageId })),
      );
      await this.deps.notices?.request(tx, [
        ...moved.completed.map(row => noticeOf(row, MaintenanceStatuses.completed)),
        ...moved.started.map(row => noticeOf(row, MaintenanceStatuses.inProgress)),
      ]);
      return moved;
    });
    await this.recordSystem(completed, AuditActions.statusMaintenanceCompleted);
    await this.recordSystem(started, AuditActions.statusMaintenanceStarted);
    await this.recordSystem(overran, AuditActions.statusMaintenanceOverran, row => ({
      runId: row.runId,
      expectedMinutes: minutesOf(row),
    }));
    await overran.reduce(async (previous, row) => {
      await previous;
      await this.alertOverrun(row);
    }, Promise.resolve());
    return { started: started.length, completed: completed.length + runEnded, overran: overran.length };
  }
}
