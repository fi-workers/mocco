// Scheduled maintenance on a status page (#148). An operator schedules or cancels a window;
// the maintenance tick (every minute) starts it and completes it. While a window is in
// progress, the components it covers show `maintenance` unless an incident is worse.
import { AuditActions } from '@mocco/common/audit';
import { MaintenanceStatuses } from '@mocco/common/status';

import {
  MaintenanceTransitionError,
  MaintenanceWindowError,
  StatusEntityNotFoundError,
} from '@backend/domain/status/errors';
import { ComponentRepo } from '@backend/domain/status/repos/component.repo';
import { MaintenanceComponentRepo } from '@backend/domain/status/repos/maintenance-component.repo';
import { MaintenanceRepo } from '@backend/domain/status/repos/maintenance.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { MaintenanceRow } from '@backend/domain/status/repos/maintenance.repo';
import type { StatusScope } from '@backend/domain/status/scope';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { Db } from '@backend/infra/db/types';
import type { MaintenanceInput } from '@mocco/common/status';

export interface MaintenanceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  pages: Pick<StatusPageService, 'requirePage'>;
  now?: () => Date;
}

const subject = (maintenanceId: string) => ({ subjectType: 'status_maintenance', subjectId: maintenanceId });

export class MaintenanceService {
  constructor(private readonly deps: MaintenanceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Audit the tick's transitions (no actor), one at a time: each append extends a workspace's hash chain. */
  private async recordSystem(
    rows: readonly MaintenanceRow[],
    action: typeof AuditActions.statusMaintenanceStarted | typeof AuditActions.statusMaintenanceCompleted,
  ): Promise<void> {
    await rows.reduce(async (previous, row) => {
      await previous;
      await this.deps.audit.record(row.workspaceId, {
        actorUserId: null,
        action,
        ...subject(row.id),
        payload: { pageId: row.pageId, projectId: row.projectId },
      });
    }, Promise.resolve());
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

  async schedule(scope: StatusScope, actorUserId: string, input: MaintenanceInput) {
    if (input.scheduledEnd <= input.scheduledStart) {
      throw new MaintenanceWindowError();
    }
    await this.deps.pages.requirePage(scope, input.pageId);
    const found = new Set(await new ComponentRepo(this.deps.db).idsOnPage(scope, input.pageId, input.componentIds));
    const missing = input.componentIds.find(id => !found.has(id));
    if (missing !== undefined) {
      throw new StatusEntityNotFoundError('component', missing);
    }
    const maintenance = await this.deps.db.transaction(async tx => {
      const created = await new MaintenanceRepo(tx).insert({
        ...scope,
        pageId: input.pageId,
        title: input.title,
        bodyMd: input.body,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        createdByUserId: actorUserId,
      });
      await new MaintenanceComponentRepo(tx).insertMany(scope.workspaceId, created.id, input.componentIds);
      return created;
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusMaintenanceScheduled,
      ...subject(maintenance.id),
      payload: {
        pageId: input.pageId,
        title: input.title,
        scheduledStart: input.scheduledStart.toISOString(),
        scheduledEnd: input.scheduledEnd.toISOString(),
        componentIds: input.componentIds,
      },
    });
    return maintenance;
  }

  /** Cancel a window that hasn't completed; one in progress ends now. */
  async cancel(scope: StatusScope, actorUserId: string, maintenanceId: string) {
    const now = this.now();
    const { maintenance, from } = await this.deps.db.transaction(async tx => {
      const windows = new MaintenanceRepo(tx);
      const current = await windows.findForUpdate(scope, maintenanceId);
      if (current === undefined) {
        throw new StatusEntityNotFoundError('maintenance', maintenanceId);
      }
      if (current.status !== MaintenanceStatuses.scheduled && current.status !== MaintenanceStatuses.inProgress) {
        throw new MaintenanceTransitionError(current.status);
      }
      const canceled = await windows.update(scope, maintenanceId, {
        status: MaintenanceStatuses.canceled,
        ...(current.status === MaintenanceStatuses.inProgress && { actualEnd: now }),
      });
      return { maintenance: canceled, from: current.status };
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusMaintenanceCanceled,
      ...subject(maintenanceId),
      payload: { from },
    });
    return maintenance;
  }

  /**
   * Move every workspace's windows along: complete those whose end has passed, then start
   * scheduled ones whose start has passed. Each transition is one conditional UPDATE, so two
   * overlapping ticks can't move a window twice. Runs as the `status.maintenance.tick` job.
   */
  async tick(now: Date = this.now()): Promise<{ started: number; completed: number }> {
    const windows = new MaintenanceRepo(this.deps.db);
    const completed = await windows.completeDue(now);
    const started = await windows.startDue(now);
    await this.recordSystem(completed, AuditActions.statusMaintenanceCompleted);
    await this.recordSystem(started, AuditActions.statusMaintenanceStarted);
    return { started: started.length, completed: completed.length };
  }
}
