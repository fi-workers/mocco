// Incidents on a status page (#148): opening one, posting updates that move it through
// investigating → identified → monitoring → resolved, the components it affects and its
// postmortem. Every change is appended to the audit log after its transaction commits.
import { AuditActions } from '@mocco/common/audit';
import { INCIDENT_TRANSITIONS, IncidentStatuses } from '@mocco/common/status';

import { IncidentTransitionError, StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { ComponentRepo } from '@backend/domain/status/repos/component.repo';
import { IncidentComponentRepo } from '@backend/domain/status/repos/incident-component.repo';
import { IncidentUpdateRepo } from '@backend/domain/status/repos/incident-update.repo';
import { IncidentRepo } from '@backend/domain/status/repos/incident.repo';
import { actorOf } from '@backend/domain/status/scope';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { IncidentRow } from '@backend/domain/status/repos/incident.repo';
import type { StatusActor, StatusScope } from '@backend/domain/status/scope';
import type { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { Db } from '@backend/infra/db/types';
import type { AffectedComponent, IncidentCreateInput, IncidentStatus, IncidentUpdateInput } from '@mocco/common/status';

export interface IncidentDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  pages: Pick<StatusPageService, 'requirePage'>;
  /** Marks the public page dirty with each change and requests a publish. */
  snapshots: Pick<SnapshotScheduler, 'change'>;
  /** Called after an incident is opened and audited (deploy correlation); must not throw. */
  onOpened?: (incident: IncidentRow) => Promise<void>;
  now?: () => Date;
}

/** The incident's status columns after an update to `to`, or IncidentTransitionError.
 * `resolved_at` is set iff the incident is resolved (the DB checks it too). */
export function transitionIncident(
  incident: Pick<IncidentRow, 'status' | 'identifiedAt'>,
  to: IncidentStatus,
  now: Date,
): { status: IncidentStatus; identifiedAt: Date | null; resolvedAt: Date | null } {
  const from = incident.status;
  const isAllowed = from !== IncidentStatuses.resolved && (from === to || INCIDENT_TRANSITIONS[from].includes(to));
  if (!isAllowed) {
    throw new IncidentTransitionError(from, to);
  }
  return {
    status: to,
    identifiedAt: incident.identifiedAt ?? (to === IncidentStatuses.identified ? now : null),
    resolvedAt: to === IncidentStatuses.resolved ? now : null,
  };
}

const subject = (incidentId: string) => ({ subjectType: 'status_incident', subjectId: incidentId });

export class IncidentService {
  constructor(private readonly deps: IncidentDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async require(scope: StatusScope, incidentId: string): Promise<IncidentRow> {
    const incident = await new IncidentRepo(this.deps.db).find(scope, incidentId);
    if (incident === undefined) {
      throw new StatusEntityNotFoundError('incident', incidentId);
    }
    return incident;
  }

  /** Every affected component must be on the incident's page. */
  private async assertComponentsOnPage(scope: StatusScope, pageId: string, components: readonly AffectedComponent[]) {
    const ids = components.map(component => component.componentId);
    const found = new Set(await new ComponentRepo(this.deps.db).idsOnPage(scope, pageId, ids));
    const missing = ids.find(id => !found.has(id));
    if (missing !== undefined) {
      throw new StatusEntityNotFoundError('component', missing);
    }
  }

  /** A page's incidents, newest first; `isOpenOnly` leaves out resolved ones. */
  async list(scope: StatusScope, pageId: string, isOpenOnly: boolean) {
    await this.deps.pages.requirePage(scope, pageId);
    return await new IncidentRepo(this.deps.db).listForPage(scope, pageId, isOpenOnly);
  }

  /** The incident with its timeline (oldest first) and affected components. */
  async get(scope: StatusScope, incidentId: string) {
    const incident = await this.require(scope, incidentId);
    const [updates, components] = await Promise.all([
      new IncidentUpdateRepo(this.deps.db).listForIncident(scope.workspaceId, incidentId),
      new IncidentComponentRepo(this.deps.db).listForIncident(scope.workspaceId, incidentId),
    ]);
    return { incident, updates, components };
  }

  /** Open an incident with its first update. */
  async create(scope: StatusScope, actor: StatusActor, input: IncidentCreateInput) {
    const { userId, via } = actorOf(actor);
    await this.deps.pages.requirePage(scope, input.pageId);
    await this.assertComponentsOnPage(scope, input.pageId, input.components);
    const now = this.now();
    const incident = await this.deps.snapshots.change(async (tx, touch) => {
      touch({ workspaceId: scope.workspaceId, pageId: input.pageId });
      const created = await new IncidentRepo(tx).insert({
        ...scope,
        pageId: input.pageId,
        title: input.title,
        severity: input.severity,
        status: input.status,
        startedAt: now,
        identifiedAt: input.status === IncidentStatuses.identified ? now : null,
        createdByUserId: userId,
      });
      await new IncidentUpdateRepo(tx).insert({
        workspaceId: scope.workspaceId,
        incidentId: created.id,
        status: input.status,
        bodyMd: input.body,
        authorUserId: userId,
      });
      await new IncidentComponentRepo(tx).replace(scope.workspaceId, created.id, input.components);
      return created;
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusIncidentCreated,
      ...subject(incident.id),
      payload: {
        pageId: input.pageId,
        title: input.title,
        severity: input.severity,
        status: input.status,
        components: input.components,
        ...via,
      },
    });
    await this.deps.onOpened?.(incident);
    return incident;
  }

  /** Post an update to the timeline, moving the incident to `input.status` if that's a legal step. */
  async postUpdate(scope: StatusScope, actor: StatusActor, incidentId: string, input: IncidentUpdateInput) {
    const { userId, via } = actorOf(actor);
    const now = this.now();
    const { incident, from, update } = await this.deps.snapshots.change(async (tx, touch) => {
      const incidents = new IncidentRepo(tx);
      const current = await incidents.findForUpdate(scope, incidentId);
      if (current === undefined) {
        throw new StatusEntityNotFoundError('incident', incidentId);
      }
      touch({ workspaceId: scope.workspaceId, pageId: current.pageId });
      const updated = await incidents.update(scope, incidentId, transitionIncident(current, input.status, now));
      const posted = await new IncidentUpdateRepo(tx).insert({
        workspaceId: scope.workspaceId,
        incidentId,
        status: input.status,
        bodyMd: input.body,
        authorUserId: userId,
      });
      return { incident: updated, from: current.status, update: posted };
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusIncidentUpdated,
      ...subject(incidentId),
      payload: { updateId: update.id, from, to: input.status, ...via },
    });
    return { incident, update };
  }

  /** Replace the components the incident affects, and how badly. */
  async setComponents(
    scope: StatusScope,
    actor: StatusActor,
    incidentId: string,
    components: readonly AffectedComponent[],
  ) {
    const { userId, via } = actorOf(actor);
    const incident = await this.require(scope, incidentId);
    await this.assertComponentsOnPage(scope, incident.pageId, components);
    await this.deps.snapshots.change(async (tx, touch) => {
      touch({ workspaceId: scope.workspaceId, pageId: incident.pageId });
      await new IncidentComponentRepo(tx).replace(scope.workspaceId, incidentId, components);
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId: userId,
      action: AuditActions.statusIncidentComponentsChanged,
      ...subject(incidentId),
      payload: { components: [...components], ...via },
    });
  }

  /** Set or clear the postmortem (Markdown). */
  async setPostmortem(scope: StatusScope, actorUserId: string, incidentId: string, postmortem: string | null) {
    await this.require(scope, incidentId);
    const incident = await new IncidentRepo(this.deps.db).update(scope, incidentId, { postmortemMd: postmortem });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusIncidentPostmortemChanged,
      ...subject(incidentId),
      payload: { length: postmortem?.length ?? 0 },
    });
    return incident;
  }
}
