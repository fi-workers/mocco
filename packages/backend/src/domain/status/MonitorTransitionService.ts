// What a monitor's state change does beyond the monitor (#150). The verdict evaluator calls
// `react` after each change commits (its `onStateChange` port, bound in compose.ts), so the
// evaluator knows nothing of pages, incidents or notifications.
//
// In one transaction, under the monitor's state lock (so reactions to one monitor never
// interleave): the pages whose components the change shows on are marked dirty, and the
// monitor's incident is opened on `down` (per its `incident_policy`), moved to monitoring
// while it recovers and resolved once it is up. After the commit the incident changes are
// audited as the system, and one alert is published per change (`status.monitor.*`, deduped
// on the state change id) for the notification rules to route.
//
// A `down` in a round of a deploy watch (#155) opens the incident with origin `deploy_watch` and
// the watched run as `suspected_run_id`, and appends `status.post_deploy_check_failed` to that
// run's timeline through the RunTimeline port. The run itself is never changed.
import { AuditActions } from '@mocco/common/audit';
import { StatusEventTypes } from '@mocco/common/events';
import { Severities } from '@mocco/common/notification';
import {
  COMPONENT_STATUS_RANK,
  ComponentImpacts,
  DeployWatch,
  IncidentOrigins,
  IncidentPolicies,
  IncidentSeverities,
  IncidentStatuses,
  IncidentVisibilities,
  MonitorStates,
  StatusRunEventTypes,
} from '@mocco/common/status';
import { z } from 'zod';

import { publishBestEffort } from '@backend/domain/events/ports';
import { monitorImpact } from '@backend/domain/status/component-status';
import { heartbeatAlertDescription } from '@backend/domain/status/heartbeat';
import { transitionIncident } from '@backend/domain/status/IncidentService';
import { monitorTargetOf } from '@backend/domain/status/monitor-target';
import { ComponentMonitorRepo } from '@backend/domain/status/repos/component-monitor.repo';
import { IncidentComponentRepo } from '@backend/domain/status/repos/incident-component.repo';
import { IncidentMonitorRepo } from '@backend/domain/status/repos/incident-monitor.repo';
import { IncidentUpdateRepo } from '@backend/domain/status/repos/incident-update.repo';
import { IncidentRepo } from '@backend/domain/status/repos/incident.repo';
import { MaintenanceComponentRepo } from '@backend/domain/status/repos/maintenance-component.repo';
import { MonitorRepo } from '@backend/domain/status/repos/monitor.repo';

import type { AuditRecordInput, AuditService } from '@backend/domain/audit/AuditService';
import type { PublishInput } from '@backend/domain/events/EventBus';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { RunTimeline } from '@backend/domain/status/ports';
import type { IncidentRow } from '@backend/domain/status/repos/incident.repo';
import type { MonitorStateChangeRow } from '@backend/domain/status/repos/monitor-state-change.repo';
import type { MonitorRow } from '@backend/domain/status/repos/monitor.repo';
import type { SnapshotScheduler, TouchPage } from '@backend/domain/status/SnapshotScheduler';
import type { Db } from '@backend/infra/db/types';
import type { ComponentImpact, IncidentSeverity, IncidentStatus, MonitorState } from '@mocco/common/status';

export interface MonitorTransitionDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  /** Marks the pages a change shows on dirty and requests a publish. */
  snapshots: Pick<SnapshotScheduler, 'change'>;
  /** Where alerts are published; without it there are none. */
  events?: EventPublisher;
  /** The app's origin, for the link in an alert. */
  appOrigin?: string;
  /** Called after the monitor's incident is opened and audited (deploy correlation); must not throw. */
  onIncidentOpened?: (incident: IncidentRow) => Promise<void>;
  /** Where a failure during a deploy watch is added to the run's timeline; without it, it isn't. */
  runTimeline?: RunTimeline;
  now?: () => Date;
}

type MonitorLink = Awaited<ReturnType<ComponentMonitorRepo['componentsOfMonitor']>>[number];
type AlertType = (typeof StatusEventTypes)[keyof typeof StatusEventTypes];

const SEVERITY_OF_IMPACT: Record<ComponentImpact, IncidentSeverity> = {
  [ComponentImpacts.majorOutage]: IncidentSeverities.major,
  [ComponentImpacts.partialOutage]: IncidentSeverities.minor,
  [ComponentImpacts.degraded]: IncidentSeverities.minor,
};

const ALERT_LOOK: Record<AlertType, { verb: string; severity: (typeof Severities)[keyof typeof Severities] }> = {
  [StatusEventTypes.statusMonitorDown]: { verb: 'Down', severity: Severities.error },
  [StatusEventTypes.statusMonitorDegraded]: { verb: 'Degraded', severity: Severities.warning },
  [StatusEventTypes.statusMonitorRecovered]: { verb: 'Recovered', severity: Severities.success },
};

const SettledStates: ReadonlySet<MonitorState> = new Set([MonitorStates.up, MonitorStates.degraded]);
const OutageStates: ReadonlySet<MonitorState> = new Set([MonitorStates.down, MonitorStates.recovering]);

/** The round tally the evaluator records on a change, when it has one. */
const tallySchema = z.object({ okCount: z.int(), failCount: z.int(), noDataCount: z.int() });

/** The alert a change sends, if any: `down`, `degraded`, or `recovered` when an outage or a
 * degradation ends. A false alarm (`suspect → up`) and a first verdict of `up` send nothing. */
function alertOf(from: MonitorState, to: MonitorState): AlertType | undefined {
  if (to === MonitorStates.down) {
    return StatusEventTypes.statusMonitorDown;
  }
  if (to === MonitorStates.degraded) {
    return StatusEventTypes.statusMonitorDegraded;
  }
  if (to === MonitorStates.up && (OutageStates.has(from) || from === MonitorStates.degraded)) {
    return StatusEventTypes.statusMonitorRecovered;
  }
  return undefined;
}

/** The update a change posts to the monitor's open incident, if any. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "no update" answer
function incidentStepOf(
  to: MonitorState,
  current: IncidentStatus,
): { status: IncidentStatus; body: string } | undefined {
  if (to === MonitorStates.down) {
    // Failing again while it recovered: the fix didn't hold.
    return current === IncidentStatuses.monitoring
      ? { status: IncidentStatuses.identified, body: 'The checks are failing again.' }
      : undefined;
  }
  if (to === MonitorStates.recovering) {
    return current === IncidentStatuses.monitoring
      ? undefined
      : {
          status: IncidentStatuses.monitoring,
          body: 'The checks are passing again. We are watching before resolving.',
        };
  }
  if (SettledStates.has(to)) {
    return {
      status: IncidentStatuses.resolved,
      body:
        to === MonitorStates.degraded
          ? 'The checks pass again, though responses are slow.'
          : 'The checks pass again. This incident is resolved.',
    };
  }
  return undefined;
}

/** The page a monitor-origin incident goes on: the one with most of the monitor's components
 * (an incident is on one page; the first in page order wins a tie). */
function incidentPageOf(links: readonly MonitorLink[]): string | undefined {
  const counts = links.reduce(
    (byPage, link) => byPage.set(link.pageId, (byPage.get(link.pageId) ?? 0) + 1),
    new Map<string, number>(),
  );
  return [...counts].reduce<[string, number] | undefined>(
    (best, entry) => (best === undefined || entry[1] > best[1] ? entry : best),
    undefined,
  )?.[0];
}

const subject = (incidentId: string) => ({ subjectType: 'status_incident', subjectId: incidentId });

/** A failure inside a deploy watch: the run watched, and how long after its release the round was. */
interface WatchFailure {
  runId: string;
  minutesAfterRelease: number;
}

/** The deploy watch a `down` change happened in, if any: its round started before `watch_until`.
 * `monitor` is the row as the evaluator left it, which keeps the watch for a watched round. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "not in a watch" answer
function watchFailureOf(monitor: MonitorRow, change: MonitorStateChangeRow): WatchFailure | undefined {
  const { watchRunId, watchUntil } = monitor;
  if (
    change.toState !== MonitorStates.down ||
    watchRunId === null ||
    watchUntil === null ||
    change.roundAt === null ||
    change.roundAt >= watchUntil
  ) {
    return undefined;
  }
  // The watch runs for `durationMs` from the release (DeployWatchService).
  const releasedAt = watchUntil.getTime() - DeployWatch.durationMs;
  return {
    runId: watchRunId,
    minutesAfterRelease: Math.max(1, Math.ceil((change.roundAt.getTime() - releasedAt) / 60_000)),
  };
}

interface Reaction {
  /** Audit entries for the incident changes, appended after the commit. */
  audits: AuditRecordInput[];
  /** The incident the monitor opened with this change, if it did. */
  opened?: IncidentRow;
  /** The monitor's incident when the change is a failure during a deploy watch. */
  watched?: { incident: IncidentRow; isOpened: boolean };
}

/** Post a system update to the monitor's incident, moving it to `step.status`. */
async function postSystemUpdate(
  tx: Db,
  touch: TouchPage,
  incident: IncidentRow,
  step: { status: IncidentStatus; body: string; monitorId: string; now: Date },
): Promise<AuditRecordInput> {
  const scope = { workspaceId: incident.workspaceId, projectId: incident.projectId };
  touch({ workspaceId: scope.workspaceId, pageId: incident.pageId });
  await new IncidentRepo(tx).update(scope, incident.id, transitionIncident(incident, step.status, step.now));
  const update = await new IncidentUpdateRepo(tx).insert({
    workspaceId: scope.workspaceId,
    incidentId: incident.id,
    status: step.status,
    bodyMd: step.body,
    authorUserId: null,
  });
  return {
    actorUserId: null,
    action: AuditActions.statusIncidentUpdated,
    ...subject(incident.id),
    payload: { updateId: update.id, from: incident.status, to: step.status, monitorId: step.monitorId },
  };
}

/** Open the monitor's incident on the page with most of its components. */
async function openMonitorIncident(
  tx: Db,
  touch: TouchPage,
  monitor: MonitorRow,
  opts: { links: readonly MonitorLink[]; isDuringMaintenance: boolean; now: Date; watch: WatchFailure | undefined },
): Promise<Reaction> {
  const pageId = incidentPageOf(opts.links);
  if (pageId === undefined) {
    return { audits: [] };
  }
  const scope = { workspaceId: monitor.workspaceId, projectId: monitor.projectId };
  const components = opts.links
    .filter(link => link.pageId === pageId)
    .map(link => ({ componentId: link.componentId, impact: link.impactWhenDown }));
  const worst = components.reduce<ComponentImpact>(
    (acc, component) => (COMPONENT_STATUS_RANK[component.impact] > COMPONENT_STATUS_RANK[acc] ? component.impact : acc),
    ComponentImpacts.degraded,
  );
  // A window in progress on the monitor's components holds a `publish` incident back as a draft.
  const visibility =
    monitor.incidentPolicy === IncidentPolicies.publish && !opts.isDuringMaintenance
      ? IncidentVisibilities.published
      : IncidentVisibilities.draft;
  const title = `${monitor.name} is down`;
  touch({ workspaceId: scope.workspaceId, pageId });
  const incident = await new IncidentRepo(tx).insert({
    ...scope,
    pageId,
    title,
    severity: SEVERITY_OF_IMPACT[worst],
    status: IncidentStatuses.investigating,
    visibility,
    startedAt: opts.now,
    origin: opts.watch === undefined ? IncidentOrigins.monitor : IncidentOrigins.deployWatch,
    suspectedRunId: opts.watch?.runId ?? null,
    createdByUserId: null,
  });
  // The body may be public: it says a deploy came first, never which repo or run.
  const opening =
    opts.watch === undefined
      ? `The monitor "${monitor.name}" is failing its checks.`
      : `The monitor "${monitor.name}" started failing within ${String(opts.watch.minutesAfterRelease)} min of a deploy.`;
  await new IncidentUpdateRepo(tx).insert({
    workspaceId: scope.workspaceId,
    incidentId: incident.id,
    status: IncidentStatuses.investigating,
    bodyMd: `${opening} We are looking into it.`,
    authorUserId: null,
  });
  await new IncidentComponentRepo(tx).replace(scope.workspaceId, incident.id, components);
  await new IncidentMonitorRepo(tx).insert({
    incidentId: incident.id,
    monitorId: monitor.id,
    workspaceId: scope.workspaceId,
  });
  return {
    opened: incident,
    ...(opts.watch !== undefined && { watched: { incident, isOpened: true } }),
    audits: [
      {
        actorUserId: null,
        action: AuditActions.statusIncidentCreated,
        ...subject(incident.id),
        payload: {
          pageId,
          title,
          severity: incident.severity,
          status: incident.status,
          visibility,
          components,
          monitorId: monitor.id,
          origin: incident.origin,
          ...(incident.suspectedRunId !== null && { suspectedRunId: incident.suspectedRunId }),
        },
      },
    ],
  };
}

/** Open, move or resolve the monitor's incident for `change`. Call under the monitor's lock. */
async function followIncident(
  tx: Db,
  touch: TouchPage,
  monitor: MonitorRow,
  change: MonitorStateChangeRow,
  opts: { links: readonly MonitorLink[]; isDuringMaintenance: boolean; now: Date; watch: WatchFailure | undefined },
): Promise<Reaction> {
  const incidentMonitors = new IncidentMonitorRepo(tx);
  const found = await incidentMonitors.findOpen(monitor.workspaceId, monitor.id);
  // An operator resolved it by hand: the link closes, and the next outage opens a new one.
  if (found?.status === IncidentStatuses.resolved) {
    await incidentMonitors.close(monitor.workspaceId, found.id, monitor.id, opts.now);
  }
  const open = found?.status === IncidentStatuses.resolved ? undefined : found;
  if (open === undefined) {
    return change.toState === MonitorStates.down && monitor.incidentPolicy !== IncidentPolicies.none
      ? await openMonitorIncident(tx, touch, monitor, opts)
      : { audits: [] };
  }
  // An outage that began before the deploy keeps its incident (it isn't re-attributed), but the
  // run's timeline still shows that the check failed during its watch.
  const watched = opts.watch === undefined ? {} : { watched: { incident: open, isOpened: false } };
  const step = incidentStepOf(change.toState, open.status);
  if (step === undefined) {
    return { audits: [], ...watched };
  }
  const audit = await postSystemUpdate(tx, touch, open, { ...step, monitorId: monitor.id, now: opts.now });
  if (step.status === IncidentStatuses.resolved) {
    await incidentMonitors.close(monitor.workspaceId, open.id, monitor.id, opts.now);
  }
  return { audits: [audit], ...watched };
}

/** The event for a change's alert: a rendered message, with the facts rules filter on. */
function alertInput(
  type: AlertType,
  monitor: MonitorRow,
  change: MonitorStateChangeRow,
  opts: { isDuringMaintenance: boolean; opened: IncidentRow | undefined; appOrigin: string | undefined },
): PublishInput {
  const { verb, severity } = ALERT_LOOK[type];
  // Only the host and port: the URL's credentials, path and query can hold secrets, and an
  // alert is read by everyone in the channel.
  const target = monitorTargetOf(monitor.spec);
  // eslint-disable-next-line sonarjs/null-dereference -- target is narrowed to a string on this branch
  const checksField = target === null ? [] : [{ name: 'Checks', value: target.slice(0, 1024), inline: false }];
  const tally = tallySchema.safeParse(change.reason);
  const isRecovery = type === StatusEventTypes.statusMonitorRecovered;
  const description = tally.success
    ? `${tally.data.failCount} failing, ${tally.data.okCount} passing, ${tally.data.noDataCount} without data in the last round.`
    : heartbeatAlertDescription(monitor, change.reason);
  const base = `/workspaces/${monitor.workspaceId}/p/${monitor.projectId}/status`;
  const path = opts.opened === undefined ? base : `${base}/incidents/${opts.opened.id}`;
  const incidentField =
    opts.opened === undefined
      ? []
      : [
          {
            name: 'Incident',
            value: opts.opened.visibility === IncidentVisibilities.draft ? 'Opened as a draft' : 'Published',
            inline: true,
          },
        ];
  return {
    type,
    workspaceId: monitor.workspaceId,
    projectId: monitor.projectId,
    subject: { type: 'status_monitor_state_change', id: change.id },
    dedupeKey: `${type}:${change.id}`,
    occurredAt: change.at,
    payload: {
      facts: { monitor: monitor.name, state: change.toState, duringMaintenance: opts.isDuringMaintenance },
      message: {
        title: `${verb}: ${monitor.name}${opts.isDuringMaintenance ? ' (during maintenance)' : ''}`.slice(0, 256),
        ...(opts.appOrigin !== undefined && { url: `${opts.appOrigin}${path}` }),
        ...(description !== undefined && !isRecovery && { description }),
        severity,
        fields: [...checksField, { name: 'Was', value: change.fromState, inline: true }, ...incidentField],
        footer: 'Mocco status',
      },
    },
  };
}

export class MonitorTransitionService {
  constructor(private readonly deps: MonitorTransitionDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Add the failure to the watched run's timeline, with the monitor's incident when there is one
   * (`incident_policy` `none` opens none). Best-effort, like an alert: the change stands. */
  private async appendWatchFailure(
    monitor: MonitorRow,
    watch: WatchFailure,
    watched: { incident: IncidentRow; isOpened: boolean } | undefined,
  ): Promise<void> {
    const incident = watched?.incident;
    const statusPath = `/workspaces/${monitor.workspaceId}/p/${monitor.projectId}/status`;
    try {
      await this.deps.runTimeline?.append(monitor.workspaceId, watch.runId, {
        type: StatusRunEventTypes.postDeployCheckFailed,
        payload: {
          monitorId: monitor.id,
          monitorName: monitor.name,
          projectId: monitor.projectId,
          incidentId: incident?.id ?? null,
          incidentTitle: incident?.title ?? null,
          incidentOpened: watched?.isOpened ?? false,
          minutesAfterRelease: watch.minutesAfterRelease,
          linkPath: incident === undefined ? statusPath : `${statusPath}/incidents/${incident.id}`,
        },
      });
    } catch (error) {
      console.error('[status] adding a post-deploy check failure to the run timeline failed', {
        monitorId: monitor.id,
        runId: watch.runId,
        error,
      });
    }
  }

  /** React to a committed state change of `monitor` (the row as the evaluator left it). */
  async react(monitor: MonitorRow, change: MonitorStateChangeRow): Promise<void> {
    const now = this.now();
    const scope = { workspaceId: monitor.workspaceId, projectId: monitor.projectId };
    const links = await new ComponentMonitorRepo(this.deps.db).componentsOfMonitor(scope.workspaceId, monitor.id);
    const isDuringMaintenance = await new MaintenanceComponentRepo(this.deps.db).isAnyInProgress(
      scope.workspaceId,
      links.map(link => link.componentId),
    );
    const watch = watchFailureOf(monitor, change);
    const reaction = await this.deps.snapshots.change(async (tx, touch) => {
      const current = await new MonitorRepo(tx).lockForStateChange(scope, monitor.id);
      if (current === undefined) {
        return { audits: [] };
      }
      // The components show the change: their pages need a new snapshot.
      const shows = links.filter(
        link =>
          monitorImpact(change.fromState, link.impactWhenDown) !== monitorImpact(change.toState, link.impactWhenDown),
      );
      touch(...shows.map(link => ({ workspaceId: scope.workspaceId, pageId: link.pageId })));
      return await followIncident(tx, touch, current, change, { links, isDuringMaintenance, now, watch });
    });
    // One at a time: each append extends the workspace's hash chain.
    await reaction.audits.reduce(async (previous, entry) => {
      await previous;
      await this.deps.audit.record(scope.workspaceId, entry);
    }, Promise.resolve());
    if (reaction.opened !== undefined) {
      await this.deps.onIncidentOpened?.(reaction.opened);
    }
    if (watch !== undefined) {
      await this.appendWatchFailure(monitor, watch, reaction.watched);
    }
    const type = alertOf(change.fromState, change.toState);
    const { events } = this.deps;
    if (type !== undefined && events !== undefined) {
      const input = alertInput(type, monitor, change, {
        isDuringMaintenance,
        opened: reaction.opened,
        appOrigin: this.deps.appOrigin,
      });
      await publishBestEffort(events, type, async () => await Promise.resolve(input));
    }
  }
}
