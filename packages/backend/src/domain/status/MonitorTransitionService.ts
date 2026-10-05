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
import { AuditActions } from '@mocco/common/audit';
import { StatusEventTypes } from '@mocco/common/events';
import { Severities } from '@mocco/common/notification';
import {
  COMPONENT_STATUS_RANK,
  ComponentImpacts,
  IncidentPolicies,
  IncidentSeverities,
  IncidentStatuses,
  IncidentVisibilities,
  MonitorStates,
} from '@mocco/common/status';
import { z } from 'zod';

import { publishBestEffort } from '@backend/domain/events/ports';
import { monitorImpact } from '@backend/domain/status/component-status';
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

interface Reaction {
  /** Audit entries for the incident changes, appended after the commit. */
  audits: AuditRecordInput[];
  /** The incident the monitor opened with this change, if it did. */
  opened?: IncidentRow;
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
  opts: { links: readonly MonitorLink[]; isDuringMaintenance: boolean; now: Date },
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
    createdByUserId: null,
  });
  await new IncidentUpdateRepo(tx).insert({
    workspaceId: scope.workspaceId,
    incidentId: incident.id,
    status: IncidentStatuses.investigating,
    bodyMd: `The monitor "${monitor.name}" is failing its checks. We are looking into it.`,
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
  opts: { links: readonly MonitorLink[]; isDuringMaintenance: boolean; now: Date },
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
  const step = incidentStepOf(change.toState, open.status);
  if (step === undefined) {
    return { audits: [] };
  }
  const audit = await postSystemUpdate(tx, touch, open, { ...step, monitorId: monitor.id, now: opts.now });
  if (step.status === IncidentStatuses.resolved) {
    await incidentMonitors.close(monitor.workspaceId, open.id, monitor.id, opts.now);
  }
  return { audits: [audit] };
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
        ...(tally.success &&
          type !== StatusEventTypes.statusMonitorRecovered && {
            description: `${tally.data.failCount} failing, ${tally.data.okCount} passing, ${tally.data.noDataCount} without data in the last round.`,
          }),
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

  /** React to a committed state change of `monitor` (the row as the evaluator left it). */
  async react(monitor: MonitorRow, change: MonitorStateChangeRow): Promise<void> {
    const now = this.now();
    const scope = { workspaceId: monitor.workspaceId, projectId: monitor.projectId };
    const links = await new ComponentMonitorRepo(this.deps.db).componentsOfMonitor(scope.workspaceId, monitor.id);
    const isDuringMaintenance = await new MaintenanceComponentRepo(this.deps.db).isAnyInProgress(
      scope.workspaceId,
      links.map(link => link.componentId),
    );
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
      return await followIncident(tx, touch, current, change, { links, isDuringMaintenance, now });
    });
    // One at a time: each append extends the workspace's hash chain.
    await reaction.audits.reduce(async (previous, entry) => {
      await previous;
      await this.deps.audit.record(scope.workspaceId, entry);
    }, Promise.resolve());
    if (reaction.opened !== undefined) {
      await this.deps.onIncidentOpened?.(reaction.opened);
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
