// A project's monitors (#150): HTTP and TCP checks run by `@mocco/probe` agents at the
// locations they are assigned to (ADR 0027), and heartbeats (#153) that a job pings. This
// service owns their settings, a heartbeat's token and the operator's pause and resume; the
// verdict evaluator and the heartbeat pings own every other state change. All of them write
// `state` under the monitor's advisory lock and record each change in
// mocco_status_monitor_state_changes, the source of truth for downtime.
import { isDeepStrictEqual } from 'node:util';

import { AuditActions } from '@mocco/common/audit';
import { MonitorKinds, MonitorStates } from '@mocco/common/status';
import { MonitorUpsertOutcomes } from '@mocco/common/status-v1';

import { MonitorKindError, MonitorPausedError, StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { silenceDeadline, silenceWindowMs } from '@backend/domain/status/heartbeat';
import { generateHeartbeatToken, hashHeartbeatToken } from '@backend/domain/status/heartbeat-token';
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
import { actorOf } from '@backend/domain/status/scope';
import { DAY_MS, HOUR_MS } from '@backend/domain/status/uptime';
import { utcDayOf } from '@backend/infra/db/day-partitions';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { MonitorRow, MonitorSettings } from '@backend/domain/status/repos/monitor.repo';
import type { StatusActor, StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { MonitorComponent, MonitorInput, MonitorState } from '@mocco/common/status';
import type { MonitorUpsertOutcome } from '@mocco/common/status-v1';

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

/** A monitor as callers see it: never its heartbeat token's hash. */
export type MonitorView = Omit<MonitorRow, 'heartbeatTokenHash'>;
export const viewOf = ({ heartbeatTokenHash: _hash, ...view }: MonitorRow): MonitorView => view;

const isHeartbeat = (kind: MonitorRow['kind']) => kind === MonitorKinds.heartbeat;

/** The unique index an upsert by key can race on. */
const KEY_CONSTRAINT = 'mocco_status_monitors_project_key_uq';

/** Who changed a monitor's state, as its state change records it. */
function reasonOf(actor: StatusActor) {
  const { userId, via } = actorOf(actor);
  return typeof actor === 'string' ? { by: 'operator', userId } : { by: 'api_key', userId, ...via };
}

/**
 * The stored settings. A heartbeat keeps only its kind in `spec`; its period and grace are
 * columns, `interval_s` mirrors the period, and it goes down on its first failure or silence, so
 * both confirmations are 1 (the DB checks it).
 */
function settingsOf(input: MonitorInput): MonitorSettings {
  const common = { name: input.name, quorumMode: input.quorumMode, incidentPolicy: input.incidentPolicy };
  const { spec } = input;
  if (spec.kind === MonitorKinds.heartbeat) {
    return {
      ...common,
      kind: spec.kind,
      spec: { kind: spec.kind },
      intervalSeconds: spec.periodSeconds,
      confirmations: 1,
      recoveryConfirmations: 1,
      heartbeatPeriodSeconds: spec.periodSeconds,
      heartbeatGraceSeconds: spec.graceSeconds,
    };
  }
  return {
    ...common,
    kind: spec.kind,
    spec,
    intervalSeconds: input.intervalSeconds,
    confirmations: input.confirmations,
    recoveryConfirmations: input.recoveryConfirmations,
    heartbeatPeriodSeconds: null,
    heartbeatGraceSeconds: null,
  };
}

/** Each location once, and each component once (the last impact given wins). */
function linksOf(input: MonitorInput): { locationIds: string[]; components: MonitorComponent[] } {
  return {
    locationIds: [...new Set(input.locationIds)],
    components: input.components.filter(
      (component, index, all) => all.findLastIndex(other => other.componentId === component.componentId) === index,
    ),
  };
}

type LinkedMonitor = MonitorView & { locationIds: string[]; components: MonitorComponent[] };

/** Ascending by code unit, like a database's C collation. */
const byText = (a: string, b: string) => Number(a > b) - Number(a < b);

/** The links in a fixed order, for comparing what is stored with what is asked. */
const sortedLinks = (links: { locationIds: readonly string[]; components: readonly MonitorComponent[] }) => ({
  locationIds: links.locationIds.toSorted(byText),
  components: links.components.toSorted((a, b) => byText(a.componentId, b.componentId)),
});

/** Whether the monitor already has the settings and links `input` asks for. */
function isAsAsked(monitor: LinkedMonitor, input: MonitorInput): boolean {
  const stored: MonitorSettings = {
    name: monitor.name,
    kind: monitor.kind,
    spec: monitor.spec,
    intervalSeconds: monitor.intervalSeconds,
    confirmations: monitor.confirmations,
    recoveryConfirmations: monitor.recoveryConfirmations,
    quorumMode: monitor.quorumMode,
    incidentPolicy: monitor.incidentPolicy,
    heartbeatPeriodSeconds: monitor.heartbeatPeriodSeconds,
    heartbeatGraceSeconds: monitor.heartbeatGraceSeconds,
  };
  // A jsonb spec comes back with its keys reordered; the comparison ignores key order.
  return (
    isDeepStrictEqual(stored, settingsOf(input)) && isDeepStrictEqual(sortedLinks(monitor), sortedLinks(linksOf(input)))
  );
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

  private async withLinks(scope: StatusScope, monitors: readonly MonitorRow[]): Promise<LinkedMonitor[]> {
    const ids = monitors.map(monitor => monitor.id);
    const [locations, components] = await Promise.all([
      new MonitorLocationRepo(this.deps.db).listFor(scope.workspaceId, ids),
      new ComponentMonitorRepo(this.deps.db).listFor(scope.workspaceId, ids),
    ]);
    return monitors.map(monitor => ({
      ...viewOf(monitor),
      locationIds: locations.filter(link => link.monitorId === monitor.id).map(link => link.locationId),
      components: components
        .filter(link => link.monitorId === monitor.id)
        .map(link => ({ componentId: link.componentId, impactWhenDown: link.impactWhenDown })),
    }));
  }

  private async changeState(
    scope: StatusScope,
    actor: StatusActor,
    monitorId: string,
    change: {
      applies: (state: MonitorState) => boolean;
      to: MonitorState;
      action: typeof AuditActions.statusMonitorPaused | typeof AuditActions.statusMonitorResumed;
    },
  ): Promise<MonitorView> {
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
          // A probe monitor's round is due now; a heartbeat's silence deadline starts over.
          ...(change.to === MonitorStates.pending && {
            nextRoundAt: isHeartbeat(current.kind) ? silenceDeadline(current, now) : now,
          }),
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
        reason: reasonOf(actor),
      });
      return { monitor, from: current.state };
    });
    if (result.from !== undefined) {
      const { userId, via } = actorOf(actor);
      await this.deps.audit.record(scope.workspaceId, {
        actorUserId: userId,
        action: change.action,
        ...subject(monitorId),
        payload: { from: result.from, to: change.to, ...via },
      });
    }
    return viewOf(result.monitor);
  }

  /** The project's monitors, each with its locations and components. */
  async list(scope: StatusScope) {
    return await this.withLinks(scope, await new MonitorRepo(this.deps.db).list(scope));
  }

  /** One monitor with its locations and components, without its history. */
  async find(scope: StatusScope, monitorId: string): Promise<LinkedMonitor> {
    const found = await new MonitorRepo(this.deps.db).find(scope, monitorId);
    if (found === undefined) {
      throw new StatusEntityNotFoundError('monitor', monitorId);
    }
    const [monitor] = await this.withLinks(scope, [found]);
    return monitor ?? { ...viewOf(found), locationIds: [], components: [] };
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
      monitor: monitor ?? { ...viewOf(found), locationIds: [], components: [] },
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

  /**
   * Create a monitor; it is `pending` and its first round is due now. A heartbeat's first
   * deadline is one period and grace away, and `heartbeatToken`, its ping token, is in this
   * answer only (null for a probe monitor).
   */
  async create(
    scope: StatusScope,
    actor: StatusActor,
    input: MonitorInput,
    key: string | null = null,
  ): Promise<MonitorView & { heartbeatToken: string | null }> {
    const { userId, via } = actorOf(actor);
    const links = linksOf(input);
    await this.assertLinks(scope, links);
    const now = this.now();
    const settings = settingsOf(input);
    const heartbeatToken = isHeartbeat(settings.kind) ? generateHeartbeatToken() : null;
    const monitor = await this.deps.db.transaction(async tx => {
      const created = await new MonitorRepo(tx).insert({
        ...scope,
        key,
        ...settings,
        state: MonitorStates.pending,
        stateChangedAt: now,
        nextRoundAt: heartbeatToken === null ? now : silenceDeadline(settings, now),
        heartbeatTokenHash: heartbeatToken === null ? null : hashHeartbeatToken(heartbeatToken),
        createdByUserId: userId,
      });
      await new MonitorLocationRepo(tx).replace(scope.workspaceId, created.id, links.locationIds);
      await new ComponentMonitorRepo(tx).replace(scope.workspaceId, created.id, links.components);
      return created;
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusMonitorCreated,
      ...subject(monitor.id),
      payload: {
        projectId: scope.projectId,
        ...(key !== null && { key }),
        name: input.name,
        kind: input.spec.kind,
        incidentPolicy: input.incidentPolicy,
        ...links,
        ...via,
      },
    });
    return { ...viewOf(monitor), heartbeatToken };
  }

  /**
   * Replace the monitor's settings, locations and components. Its state is kept. A monitor stays
   * a heartbeat or a probe kind (`MonitorKindError`); a heartbeat's new period and grace apply to
   * the deadline it is waiting on.
   */
  async update(scope: StatusScope, actor: StatusActor, monitorId: string, input: MonitorInput): Promise<MonitorView> {
    const { userId, via } = actorOf(actor);
    const links = linksOf(input);
    await this.assertLinks(scope, links);
    const settings = settingsOf(input);
    const now = this.now();
    const monitor = await this.deps.db.transaction(async tx => {
      const monitors = new MonitorRepo(tx);
      const current = await monitors.lockForStateChange(scope, monitorId);
      if (current === undefined) {
        throw new StatusEntityNotFoundError('monitor', monitorId);
      }
      if (isHeartbeat(current.kind) !== isHeartbeat(settings.kind)) {
        throw new MonitorKindError('A monitor stays a heartbeat or a probe check; create a new monitor to switch');
      }
      const updated = await monitors.updateSettings(scope, monitorId, settings);
      if (updated === undefined) {
        throw new StatusEntityNotFoundError('monitor', monitorId);
      }
      await new MonitorLocationRepo(tx).replace(scope.workspaceId, monitorId, links.locationIds);
      await new ComponentMonitorRepo(tx).replace(scope.workspaceId, monitorId, links.components);
      if (!isHeartbeat(current.kind) || current.state === MonitorStates.paused) {
        return updated;
      }
      // The deadline counts from the same moment (the last ping, the creation or the resume),
      // with the new period and grace.
      const since = new Date(current.nextRoundAt.getTime() - silenceWindowMs(current));
      return await monitors.setNextRound(scope, monitorId, silenceDeadline(settings, since), now);
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusMonitorUpdated,
      ...subject(monitorId),
      payload: { name: input.name, kind: input.spec.kind, incidentPolicy: input.incidentPolicy, ...links, ...via },
    });
    return viewOf(monitor);
  }

  /**
   * Make the project's monitor with this key look like `input` (`PUT /v1/monitors/by-key/:key`,
   * #159): create it when there is none, change it when it differs, and leave it alone (no write,
   * no audit entry) when it already matches, so CI can run the same upsert on every deploy. A new
   * heartbeat's ping token is in the answer that creates it only. Changing between a heartbeat
   * and a probe kind is a `MonitorKindError`, as in `update`.
   */
  async upsertByKey(
    scope: StatusScope,
    actor: StatusActor,
    key: string,
    input: MonitorInput,
  ): Promise<{ outcome: MonitorUpsertOutcome; monitor: LinkedMonitor; heartbeatToken: string | null }> {
    const existing = await new MonitorRepo(this.deps.db).findByKey(scope, key);
    if (existing === undefined) {
      try {
        const { heartbeatToken, id } = await this.create(scope, actor, input, key);
        return { outcome: MonitorUpsertOutcomes.created, monitor: await this.find(scope, id), heartbeatToken };
      } catch (error) {
        // Two upserts of a new key raced and the other one created it: this one updates it.
        if (!(error instanceof UniqueConstraintError && error.constraint === KEY_CONSTRAINT)) {
          throw error;
        }
        return await this.upsertByKey(scope, actor, key, input);
      }
    }
    const current = await this.find(scope, existing.id);
    if (isAsAsked(current, input)) {
      return { outcome: MonitorUpsertOutcomes.unchanged, monitor: current, heartbeatToken: null };
    }
    await this.update(scope, actor, existing.id, input);
    return {
      outcome: MonitorUpsertOutcomes.updated,
      monitor: await this.find(scope, existing.id),
      heartbeatToken: null,
    };
  }

  /** Issue a new ping token for a heartbeat; the old one stops working at once. The token is in
   * this answer only. */
  async rotateHeartbeatToken(
    scope: StatusScope,
    actorUserId: string,
    monitorId: string,
  ): Promise<{ monitor: MonitorView; token: string }> {
    const token = generateHeartbeatToken();
    const now = this.now();
    const monitor = await this.deps.db.transaction(async tx => {
      const monitors = new MonitorRepo(tx);
      const current = await monitors.lockForStateChange(scope, monitorId);
      if (current === undefined) {
        throw new StatusEntityNotFoundError('monitor', monitorId);
      }
      if (!isHeartbeat(current.kind)) {
        throw new MonitorKindError(`Monitor ${monitorId} isn't a heartbeat; it has no ping token`);
      }
      return await monitors.setHeartbeatTokenHash(scope, monitorId, hashHeartbeatToken(token), now);
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusMonitorHeartbeatTokenRotated,
      ...subject(monitorId),
      payload: { name: monitor.name },
    });
    return { monitor: viewOf(monitor), token };
  }

  /** Stop checking the monitor. Pausing a paused monitor changes nothing. A paused heartbeat
   * still accepts pings, but they don't move its state. */
  async pause(scope: StatusScope, actor: StatusActor, monitorId: string): Promise<MonitorView> {
    return await this.changeState(scope, actor, monitorId, {
      applies: state => state !== MonitorStates.paused,
      to: MonitorStates.paused,
      action: AuditActions.statusMonitorPaused,
    });
  }

  /** Check the monitor again: it is `pending` until its next verdict, and a round is due now.
   * Resuming a monitor that isn't paused changes nothing. */
  async resume(scope: StatusScope, actor: StatusActor, monitorId: string): Promise<MonitorView> {
    return await this.changeState(scope, actor, monitorId, {
      applies: state => state === MonitorStates.paused,
      to: MonitorStates.pending,
      action: AuditActions.statusMonitorResumed,
    });
  }

  /**
   * Run a round now (`POST /v1/monitors/:id/check`, #155): a round that isn't due yet is pulled
   * to now; one already due or open stays. Returns the round's time. The state and streaks are
   * the evaluator's, so nothing else changes and the verdict follows as for any round. A paused
   * monitor has no rounds: `MonitorPausedError`; neither has a heartbeat: `MonitorKindError`.
   */
  async requestCheck(scope: StatusScope, monitorId: string): Promise<{ monitorId: string; roundAt: Date }> {
    const now = this.deps.now?.() ?? new Date();
    return await this.deps.db.transaction(async tx => {
      const monitors = new MonitorRepo(tx);
      const monitor = await monitors.lockForStateChange(scope, monitorId);
      if (monitor === undefined) {
        throw new StatusEntityNotFoundError('monitor', monitorId);
      }
      if (isHeartbeat(monitor.kind)) {
        throw new MonitorKindError(
          `Monitor ${monitorId} is a heartbeat; its job pings it, so it has no rounds to check`,
        );
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
  async delete(scope: StatusScope, actor: StatusActor, monitorId: string): Promise<void> {
    const { userId, via } = actorOf(actor);
    const monitor = await new MonitorRepo(this.deps.db).find(scope, monitorId);
    if (monitor === undefined || !(await new MonitorRepo(this.deps.db).delete(scope, monitorId))) {
      throw new StatusEntityNotFoundError('monitor', monitorId);
    }
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusMonitorDeleted,
      ...subject(monitorId),
      payload: {
        projectId: scope.projectId,
        ...(monitor.key !== null && { key: monitor.key }),
        name: monitor.name,
        ...via,
      },
    });
  }
}
