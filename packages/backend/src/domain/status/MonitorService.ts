// A project's monitors (#150): HTTP and TCP checks run by `@mocco/probe` agents at the
// locations they are assigned to (ADR 0027). This service owns their settings and the
// operator's pause and resume; the verdict evaluator owns every other state change. Both
// write `state` under the monitor's advisory lock and record each change in
// mocco_status_monitor_state_changes, the source of truth for downtime.
import { AuditActions } from '@mocco/common/audit';
import { MonitorStates } from '@mocco/common/status';

import { MonitorPausedError, StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { percentilesOf } from '@backend/domain/status/latency-hist';
import { ComponentMonitorRepo } from '@backend/domain/status/repos/component-monitor.repo';
import { ComponentRepo } from '@backend/domain/status/repos/component.repo';
import { IncidentMonitorRepo } from '@backend/domain/status/repos/incident-monitor.repo';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { MonitorLocationRepo } from '@backend/domain/status/repos/monitor-location.repo';
import { MonitorStateChangeRepo } from '@backend/domain/status/repos/monitor-state-change.repo';
import { MonitorRepo } from '@backend/domain/status/repos/monitor.repo';
import { RollupDailyRepo } from '@backend/domain/status/repos/rollup-daily.repo';
import { RollupHourlyRepo } from '@backend/domain/status/repos/rollup-hourly.repo';
import { RoundVerdictRepo } from '@backend/domain/status/repos/round-verdict.repo';
import { DAY_MS, HOUR_MS } from '@backend/domain/status/uptime';
import { utcDayOf } from '@backend/infra/db/day-partitions';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { MonitorRow, MonitorSettings } from '@backend/domain/status/repos/monitor.repo';
import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { MonitorComponent, MonitorInput, MonitorState } from '@mocco/common/status';

export interface MonitorDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  now?: () => Date;
}

/** Closed rounds `get` returns, newest first. */
const RECENT_VERDICTS = 10;
/** The history `get` returns: the last 48 hours and the last 90 UTC days. */
export const MonitorHistoryWindow = { hours: 48, days: 90 } as const;

const subject = (monitorId: string) => ({ subjectType: 'status_monitor', subjectId: monitorId });

const settingsOf = (input: MonitorInput): MonitorSettings => ({
  name: input.name,
  kind: input.spec.kind,
  spec: input.spec,
  intervalSeconds: input.intervalSeconds,
  confirmations: input.confirmations,
  recoveryConfirmations: input.recoveryConfirmations,
  quorumMode: input.quorumMode,
  incidentPolicy: input.incidentPolicy,
});

/** Each location once, and each component once (the last impact given wins). */
function linksOf(input: MonitorInput): { locationIds: string[]; components: MonitorComponent[] } {
  return {
    locationIds: [...new Set(input.locationIds)],
    components: input.components.filter(
      (component, index, all) => all.findLastIndex(other => other.componentId === component.componentId) === index,
    ),
  };
}

export class MonitorService {
  constructor(private readonly deps: MonitorDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Every location must be usable by the workspace (enabled, and hosted or its own), and every
   * component must be on one of the project's pages. */
  private async assertLinks(scope: StatusScope, links: ReturnType<typeof linksOf>): Promise<void> {
    const usable = new Set(await new LocationRepo(this.deps.db).usableIds(scope.workspaceId, links.locationIds));
    const missingLocation = links.locationIds.find(id => !usable.has(id));
    if (missingLocation !== undefined) {
      throw new StatusEntityNotFoundError('location', missingLocation);
    }
    const componentIds = links.components.map(component => component.componentId);
    const found = new Set(await new ComponentRepo(this.deps.db).idsInProject(scope, componentIds));
    const missingComponent = componentIds.find(id => !found.has(id));
    if (missingComponent !== undefined) {
      throw new StatusEntityNotFoundError('component', missingComponent);
    }
  }

  private async withLinks(scope: StatusScope, monitors: readonly MonitorRow[]) {
    const ids = monitors.map(monitor => monitor.id);
    const [locations, components] = await Promise.all([
      new MonitorLocationRepo(this.deps.db).listFor(scope.workspaceId, ids),
      new ComponentMonitorRepo(this.deps.db).listFor(scope.workspaceId, ids),
    ]);
    return monitors.map(monitor => ({
      ...monitor,
      locationIds: locations.filter(link => link.monitorId === monitor.id).map(link => link.locationId),
      components: components
        .filter(link => link.monitorId === monitor.id)
        .map(link => ({ componentId: link.componentId, impactWhenDown: link.impactWhenDown })),
    }));
  }

  private async changeState(
    scope: StatusScope,
    actorUserId: string,
    monitorId: string,
    change: {
      applies: (state: MonitorState) => boolean;
      to: MonitorState;
      action: typeof AuditActions.statusMonitorPaused | typeof AuditActions.statusMonitorResumed;
    },
  ): Promise<MonitorRow> {
    const now = this.now();
    const result = await this.deps.db.transaction(async tx => {
      const monitors = new MonitorRepo(tx);
      const current = await monitors.lockForStateChange(scope, monitorId);
      if (current === undefined) {
        throw new StatusEntityNotFoundError('monitor', monitorId);
      }
      if (!change.applies(current.state)) {
        return { monitor: current, from: undefined };
      }
      const monitor = await monitors.setState(
        scope,
        monitorId,
        {
          state: change.to,
          stateChangedAt: now,
          ...(change.to === MonitorStates.pending && { nextRoundAt: now }),
          // Pausing or resuming starts over: earlier rounds don't count toward confirmations.
          consecutiveFails: 0,
          consecutiveOks: 0,
        },
        now,
      );
      await new MonitorStateChangeRepo(tx).append({
        workspaceId: scope.workspaceId,
        monitorId,
        fromState: current.state,
        toState: change.to,
        at: now,
        reason: { by: 'operator', userId: actorUserId },
      });
      return { monitor, from: current.state };
    });
    if (result.from !== undefined) {
      await this.deps.audit.record(scope.workspaceId, {
        actorUserId,
        action: change.action,
        ...subject(monitorId),
        payload: { from: result.from, to: change.to },
      });
    }
    return result.monitor;
  }

  /** The project's monitors, each with its locations and components. */
  async list(scope: StatusScope) {
    return await this.withLinks(scope, await new MonitorRepo(this.deps.db).list(scope));
  }

  /**
   * The monitor with its locations and components, its latest state changes and closed rounds
   * (newest first), and the incident it opened that is still open, if any.
   */
  async get(scope: StatusScope, monitorId: string) {
    const found = await new MonitorRepo(this.deps.db).find(scope, monitorId);
    if (found === undefined) {
      throw new StatusEntityNotFoundError('monitor', monitorId);
    }
    const now = this.now().getTime();
    const [[monitor], stateChanges, recentVerdicts, openIncident, hours, days] = await Promise.all([
      this.withLinks(scope, [found]),
      new MonitorStateChangeRepo(this.deps.db).listForMonitor(scope.workspaceId, monitorId),
      new RoundVerdictRepo(this.deps.db).listLatestForMonitor(scope.workspaceId, monitorId, RECENT_VERDICTS),
      new IncidentMonitorRepo(this.deps.db).findOpen(scope.workspaceId, monitorId),
      new RollupHourlyRepo(this.deps.db).listForMonitor(
        scope.workspaceId,
        monitorId,
        new Date(Math.floor(now / HOUR_MS) * HOUR_MS - (MonitorHistoryWindow.hours - 1) * HOUR_MS),
      ),
      new RollupDailyRepo(this.deps.db).listForMonitor(
        scope.workspaceId,
        monitorId,
        utcDayOf(new Date(now - (MonitorHistoryWindow.days - 1) * DAY_MS)),
      ),
    ]);
    return {
      monitor: monitor ?? { ...found, locationIds: [], components: [] },
      stateChanges,
      recentVerdicts,
      openIncident: openIncident ?? null,
      // Uptime and latency from the rollups, oldest first; percentiles come from the merged
      // histograms. Hours and days the rollup job hasn't written are absent.
      history: {
        hours: hours.map(row => ({
          hour: row.hour,
          rounds: row.rounds,
          downSeconds: row.downSeconds,
          ...percentilesOf(row.latencyHist),
        })),
        days: days.map(row => ({
          day: row.day,
          rounds: row.rounds,
          downSeconds: row.downSeconds,
          uptimeRatio: row.uptimeRatio,
          ...percentilesOf(row.latencyHist),
        })),
      },
    };
  }

  /** Create a monitor; it is `pending` and its first round is due now. */
  async create(scope: StatusScope, actorUserId: string, input: MonitorInput): Promise<MonitorRow> {
    const links = linksOf(input);
    await this.assertLinks(scope, links);
    const now = this.now();
    const monitor = await this.deps.db.transaction(async tx => {
      const created = await new MonitorRepo(tx).insert({
        ...scope,
        ...settingsOf(input),
        state: MonitorStates.pending,
        stateChangedAt: now,
        nextRoundAt: now,
        createdByUserId: actorUserId,
      });
      await new MonitorLocationRepo(tx).replace(scope.workspaceId, created.id, links.locationIds);
      await new ComponentMonitorRepo(tx).replace(scope.workspaceId, created.id, links.components);
      return created;
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusMonitorCreated,
      ...subject(monitor.id),
      payload: {
        projectId: scope.projectId,
        name: input.name,
        kind: input.spec.kind,
        incidentPolicy: input.incidentPolicy,
        ...links,
      },
    });
    return monitor;
  }

  /** Replace the monitor's settings, locations and components. Its state is kept. */
  async update(scope: StatusScope, actorUserId: string, monitorId: string, input: MonitorInput): Promise<MonitorRow> {
    const links = linksOf(input);
    await this.assertLinks(scope, links);
    const monitor = await this.deps.db.transaction(async tx => {
      const updated = await new MonitorRepo(tx).updateSettings(scope, monitorId, settingsOf(input));
      if (updated === undefined) {
        throw new StatusEntityNotFoundError('monitor', monitorId);
      }
      await new MonitorLocationRepo(tx).replace(scope.workspaceId, monitorId, links.locationIds);
      await new ComponentMonitorRepo(tx).replace(scope.workspaceId, monitorId, links.components);
      return updated;
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusMonitorUpdated,
      ...subject(monitorId),
      payload: { name: input.name, kind: input.spec.kind, incidentPolicy: input.incidentPolicy, ...links },
    });
    return monitor;
  }

  /** Stop checking the monitor. Pausing a paused monitor changes nothing. */
  async pause(scope: StatusScope, actorUserId: string, monitorId: string): Promise<MonitorRow> {
    return await this.changeState(scope, actorUserId, monitorId, {
      applies: state => state !== MonitorStates.paused,
      to: MonitorStates.paused,
      action: AuditActions.statusMonitorPaused,
    });
  }

  /** Check the monitor again: it is `pending` until its next verdict, and a round is due now.
   * Resuming a monitor that isn't paused changes nothing. */
  async resume(scope: StatusScope, actorUserId: string, monitorId: string): Promise<MonitorRow> {
    return await this.changeState(scope, actorUserId, monitorId, {
      applies: state => state === MonitorStates.paused,
      to: MonitorStates.pending,
      action: AuditActions.statusMonitorResumed,
    });
  }

  /**
   * Run a round now (`POST /v1/monitors/:id/check`, #155): a round that isn't due yet is pulled
   * to now; one already due or open stays. Returns the round's time. The state and streaks are
   * the evaluator's, so nothing else changes and the verdict follows as for any round. A paused
   * monitor has no rounds: `MonitorPausedError`.
   */
  async requestCheck(scope: StatusScope, monitorId: string): Promise<{ monitorId: string; roundAt: Date }> {
    const now = this.deps.now?.() ?? new Date();
    return await this.deps.db.transaction(async tx => {
      const monitors = new MonitorRepo(tx);
      const monitor = await monitors.lockForStateChange(scope, monitorId);
      if (monitor === undefined) {
        throw new StatusEntityNotFoundError('monitor', monitorId);
      }
      if (monitor.state === MonitorStates.paused) {
        throw new MonitorPausedError(monitorId);
      }
      if (monitor.nextRoundAt <= now) {
        return { monitorId, roundAt: monitor.nextRoundAt };
      }
      await monitors.setNextRound(scope, monitorId, now, now);
      return { monitorId, roundAt: now };
    });
  }

  /** Delete the monitor with its links and state history. */
  async delete(scope: StatusScope, actorUserId: string, monitorId: string): Promise<void> {
    const monitor = await new MonitorRepo(this.deps.db).find(scope, monitorId);
    if (monitor === undefined || !(await new MonitorRepo(this.deps.db).delete(scope, monitorId))) {
      throw new StatusEntityNotFoundError('monitor', monitorId);
    }
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusMonitorDeleted,
      ...subject(monitorId),
      payload: { projectId: scope.projectId, name: monitor.name },
    });
  }
}
