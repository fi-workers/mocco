// Deploy correlation (#154): the runs an incident is linked to, both ways. When an incident
// opens, Mocco suggests the recorded releases (docs/reference/releases.md) that finished in the
// window around its start, scored by how close they were (twice as much for the run whose deploy
// watch opened it); a person links or unlinks any run of
// the workspace (audited). Releases and runs are read through the DeploySource port, so the
// execution and project domains never depend on status.
import { AuditActions } from '@mocco/common/audit';
import { CorrelationWindow, IncidentRunRelations } from '@mocco/common/status';

import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { IncidentRunRepo } from '@backend/domain/status/repos/incident-run.repo';
import { IncidentRepo } from '@backend/domain/status/repos/incident.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { DeployRelease, DeploySource } from '@backend/domain/status/ports';
import type { IncidentRunRow } from '@backend/domain/status/repos/incident-run.repo';
import type { IncidentRow } from '@backend/domain/status/repos/incident.repo';
import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { IncidentRunDto, IncidentRunRelation, RunIncidentDto } from '@mocco/common/status';

export interface CorrelationDeps {
  db: Db;
  deploys: DeploySource;
  audit: Pick<AuditService, 'record'>;
}

/** Suggestions kept per incident, best first. */
export const MAX_SUGGESTED_RUNS = 20;

/** A release of the incident's own project (its repos are linked) counts this much more. */
export const LINKED_REPO_FACTOR = 1.5;

/** The run whose deploy watch the incident's first failure happened in counts this much more. */
export const DEPLOY_WATCH_FACTOR = 2;

const MINUTE_MS = 60_000;

/** The window releases are correlated in: `[startedAt - 2h, startedAt + 5m]`. */
export function correlationWindow(startedAt: Date): { from: Date; to: Date } {
  return {
    from: new Date(startedAt.getTime() - CorrelationWindow.beforeMs),
    to: new Date(startedAt.getTime() + CorrelationWindow.afterMs),
  };
}

/**
 * How suspicious a release is: `1 / (1 + minutes / 10)`, where `minutes` is how far it finished
 * from the incident's start (either side), times 1.5 for a release of a repo the incident's
 * project links, and times 2 when the incident opened during that run's deploy watch.
 */
export function deployScore(
  release: { releasedAt: Date },
  startedAt: Date,
  isLinkedRepo: boolean,
  isWatchedRun = false,
): number {
  const minutes = Math.abs(startedAt.getTime() - release.releasedAt.getTime()) / MINUTE_MS;
  return (1 / (1 + minutes / 10)) * (isLinkedRepo ? LINKED_REPO_FACTOR : 1) * (isWatchedRun ? DEPLOY_WATCH_FACTOR : 1);
}

/**
 * The suggested links for an incident: one per run (its best score), best first and at most
 * `MAX_SUGGESTED_RUNS`. The best is `suspected`, the others `before_window`.
 */
export function rankReleases(
  releases: readonly DeployRelease[],
  incident: Pick<IncidentRow, 'startedAt' | 'projectId'> & Partial<Pick<IncidentRow, 'suspectedRunId'>>,
  isScopedToProject: boolean,
): { runId: string; score: number; relation: IncidentRunRelation }[] {
  const best = releases.reduce((scores, release) => {
    const isLinkedRepo = isScopedToProject && release.projectId === incident.projectId;
    // `suspected_run_id` is set only on an incident a deploy watch opened (#155).
    const isWatchedRun = release.runId === (incident.suspectedRunId ?? undefined);
    const score = deployScore(release, incident.startedAt, isLinkedRepo, isWatchedRun);
    return scores.set(release.runId, Math.max(score, scores.get(release.runId) ?? 0));
  }, new Map<string, number>());
  return [...best]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SUGGESTED_RUNS)
    .map(([runId, score], index) => ({
      runId,
      score,
      relation: index === 0 ? IncidentRunRelations.suspected : IncidentRunRelations.beforeWindow,
    }));
}

/** The link as the wire shows it, without its workspace and incident. */
const linkOf = (link: IncidentRunRow) => ({
  runId: link.runId,
  relation: link.relation,
  score: link.score,
  linkedByUserId: link.linkedByUserId,
  linkedAt: link.createdAt,
});

const subject = (incidentId: string) => ({ subjectType: 'status_incident', subjectId: incidentId });

export class CorrelationService {
  constructor(private readonly deps: CorrelationDeps) {}

  private async requireIncident(scope: StatusScope, incidentId: string): Promise<IncidentRow> {
    const incident = await new IncidentRepo(this.deps.db).find(scope, incidentId);
    if (incident === undefined) {
      throw new StatusEntityNotFoundError('incident', incidentId);
    }
    return incident;
  }

  /**
   * Suggest the releases around the incident's start. When the incident's project links repos,
   * only that project's releases of those repos count, so a run of an unlinked repo or outside
   * the window is never suggested; when it links none, every release in the workspace counts.
   * Replaces earlier suggestions and keeps a person's links. Returns how many it suggested.
   */
  private async suggest(incident: IncidentRow): Promise<number> {
    const { workspaceId, projectId } = incident;
    const isScopedToProject = await this.deps.deploys.projectHasRepos(workspaceId, projectId);
    const releases = await this.deps.deploys.releasesBetween(workspaceId, {
      ...correlationWindow(incident.startedAt),
      ...(isScopedToProject && { projectId }),
    });
    const ranked = rankReleases(releases, incident, isScopedToProject);
    await new IncidentRunRepo(this.deps.db).replaceSuggestions(
      workspaceId,
      incident.id,
      ranked.map(row => ({ ...row, incidentId: incident.id, workspaceId, linkedByUserId: null })),
    );
    return ranked.length;
  }

  /** Recompute the suggestions for an incident (on demand). */
  async correlate(scope: StatusScope, incidentId: string): Promise<{ suggested: number }> {
    return { suggested: await this.suggest(await this.requireIncident(scope, incidentId)) };
  }

  /** Suggest runs for an incident that just opened. Never throws: the incident is already
   * stored, and a person can recompute the suggestions later. */
  async onIncidentOpened(incident: IncidentRow): Promise<void> {
    try {
      await this.suggest(incident);
    } catch (error) {
      console.error(`[status] correlating incident ${incident.id} failed`, error);
    }
  }

  /** The incident's runs, best suggestion first, with what the console shows about each run. */
  async list(scope: StatusScope, incidentId: string): Promise<IncidentRunDto[]> {
    await this.requireIncident(scope, incidentId);
    const links = await new IncidentRunRepo(this.deps.db).listForIncident(scope.workspaceId, incidentId);
    const runs = await this.deps.deploys.runSummaries(
      scope.workspaceId,
      links.map(link => link.runId),
    );
    const byId = new Map(runs.map(run => [run.runId, run]));
    return links.map(link => {
      const run = byId.get(link.runId);
      return {
        ...linkOf(link),
        run:
          run === undefined
            ? null
            : {
                state: run.state,
                repoFullName: run.repoFullName,
                commitSha: run.commitSha,
                finishedAt: run.finishedAt,
              },
      };
    });
  }

  /** Link a run of the workspace to the incident (audited). A suggestion for the run becomes this link. */
  async link(
    scope: StatusScope,
    actorUserId: string,
    input: { incidentId: string; runId: string; relation: IncidentRunRelation },
  ) {
    await this.requireIncident(scope, input.incidentId);
    const [run] = await this.deps.deploys.runSummaries(scope.workspaceId, [input.runId]);
    if (run === undefined) {
      throw new StatusEntityNotFoundError('run', input.runId);
    }
    const link = await new IncidentRunRepo(this.deps.db).upsertLink({
      incidentId: input.incidentId,
      runId: input.runId,
      workspaceId: scope.workspaceId,
      relation: input.relation,
      score: null,
      linkedByUserId: actorUserId,
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusIncidentRunLinked,
      ...subject(input.incidentId),
      payload: { runId: input.runId, relation: input.relation },
    });
    return linkOf(link);
  }

  /** Remove a run's link, a suggestion or a person's (audited). */
  async unlink(scope: StatusScope, actorUserId: string, input: { incidentId: string; runId: string }): Promise<void> {
    await this.requireIncident(scope, input.incidentId);
    const removed = await new IncidentRunRepo(this.deps.db).delete(scope.workspaceId, input.incidentId, input.runId);
    if (removed === undefined) {
      throw new StatusEntityNotFoundError('run link', input.runId);
    }
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusIncidentRunUnlinked,
      ...subject(input.incidentId),
      payload: { runId: input.runId, relation: removed.relation },
    });
  }

  /** The incidents a run of the workspace is linked to, across its projects, newest first. */
  async incidentsForRun(workspaceId: string, runId: string): Promise<RunIncidentDto[]> {
    const [run] = await this.deps.deploys.runSummaries(workspaceId, [runId]);
    if (run === undefined) {
      throw new StatusEntityNotFoundError('run', runId);
    }
    const rows = await new IncidentRunRepo(this.deps.db).listForRun(workspaceId, runId);
    return rows.map(({ incident, link }) => ({
      incidentId: incident.id,
      projectId: incident.projectId,
      pageId: incident.pageId,
      title: incident.title,
      status: incident.status,
      severity: incident.severity,
      startedAt: incident.startedAt,
      relation: link.relation,
      score: link.score,
    }));
  }
}
