import { DomainEventTypes } from '@mocco/common/events';
import { RunStates } from '@mocco/common/execution';
import { GateStates, ResumeDecisions } from '@mocco/common/governance';

import {
  EventSubjectTypes,
  governanceDedupeKey,
  loadRunEventSubject,
} from '@backend/domain/execution/run-event-subject';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { EventPublisher } from '@backend/domain/events/ports';
import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import type { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import type { ProjectRepoRepo } from '@backend/domain/project/repos/project-repo.repo';
import type { ReleaseRepo } from '@backend/domain/project/repos/release.repo';
import type { ReleaseGate } from '@mocco/common/events';

/** How far back `reconcile` looks for released runs the registry missed. Well inside the
 * 30-day event retention, so a published `deploy.released` is still there to be found. */
export const RELEASE_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs one reconcile pass records at most; the next pass continues. */
export const RELEASE_RECONCILE_BATCH_SIZE = 100;

export interface ReleaseServiceDeps {
  releases: ReleaseRepo;
  projectRepos: ProjectRepoRepo;
  /** The execution and governance repos the release is read from (cross-domain injection). */
  runs: RunRepo;
  runGates: RunGateRepo;
  resumes: ResumeRepo;
  /** Publishes `deploy.released`. */
  bus: EventPublisher;
}

/** What `recordRun` did for a released run. */
export interface RecordedRelease {
  projectIds: string[];
  /** Release rows this call inserted (0 on a repeat). */
  inserted: number;
}

/** Each person once per role, across the gates in order. */
function uniqueResumers(gates: ReleaseGate[]): ReleaseGate['resumedBy'] {
  const seen = new Set<string>();
  return gates
    .flatMap(gate => gate.resumedBy)
    .filter(resumer => {
      const key = `${resumer.userId}:${resumer.role ?? ''}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

/**
 * The release registry (platform foundations §4, §15). A run is a release when it succeeded
 * and passed at least one resumed gate (ADR 0003 has no environments; a resumed gate is what
 * marks a production deploy). It is recorded once for every project its repo is linked to
 * when it is first recorded, and announced once as `deploy.released`. Both writes are idempotent, so
 * the `run.succeeded` subscriber can be retried and the reconcile job can repeat it.
 */
export class ReleaseService {
  constructor(private readonly deps: ReleaseServiceDeps) {}

  /** The run with its repo and commit, or undefined once it is gone (deleted with its repo). */
  private async findRun(workspaceId: string, runId: string) {
    try {
      return await this.deps.runs.getWithContextInWorkspace(workspaceId, runId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Record a run's releases and publish `deploy.released`, or return undefined when the run
   * is not a release (not succeeded, no resumed gate, no linked project, or gone). A failed
   * publish throws, so the subscriber's job retries; the rows already written stay and the
   * retry publishes the one event (its dedupe key is `deploy.released:<runId>`).
   */
  async recordRun(workspaceId: string, runId: string): Promise<RecordedRelease | undefined> {
    const context = await this.findRun(workspaceId, runId);
    if (context?.run.state !== RunStates.succeeded) {
      return undefined;
    }
    const { run, repo, commit } = context;
    const runGates = await this.deps.runGates.findByRun(workspaceId, runId);
    const gates = runGates.filter(gate => gate.state === GateStates.resumed);
    if (gates.length === 0) {
      return undefined;
    }
    const releasedAt = run.finishedAt ?? run.updatedAt;
    // The projects linked when the release is first recorded. That set is then fixed: the
    // reconcile job only revisits a run with no release row at all (or no event), so a project
    // linked afterwards does not inherit the repo's past releases.
    const links = await this.deps.projectRepos.listByRepo(workspaceId, repo.id);
    const projectIds = links.map(link => link.projectId);
    if (projectIds.length === 0) {
      return undefined;
    }

    const votes = await this.deps.resumes.listByRun(workspaceId, runId);
    const releaseGates: ReleaseGate[] = gates.map(gate => ({
      gateId: gate.id,
      name: gate.name,
      resumedBy: votes
        .filter(vote => vote.runGateId === gate.id && vote.decision === ResumeDecisions.resume)
        .map(vote => ({ userId: vote.userId, role: vote.roleName })),
    }));
    const previous = await this.deps.releases.findPreviousForRepo(workspaceId, repo.id, releasedAt);
    const inserted = await this.deps.releases.insertMissing(
      projectIds.map(projectId => ({
        workspaceId,
        projectId,
        runId,
        repoId: repo.id,
        commitSha: commit.sha,
        gates: releaseGates,
        releasedAt,
      })),
    );

    await this.deps.bus.publish({
      type: DomainEventTypes.deployReleased,
      workspaceId,
      subject: { type: EventSubjectTypes.run, id: runId },
      dedupeKey: governanceDedupeKey(DomainEventTypes.deployReleased, runId),
      occurredAt: releasedAt,
      payload: {
        ...(await loadRunEventSubject(this.deps.runs, workspaceId, runId)),
        repoId: repo.id,
        projectIds,
        previousReleaseSha: previous?.commitSha ?? null,
        gates: releaseGates,
        resumedBy: uniqueResumers(releaseGates),
        releasedAt: releasedAt.toISOString(),
      },
    });
    return { projectIds, inserted: inserted.length };
  }

  /**
   * Record the released runs the subscriber missed (a crash between a run's state change and
   * its `run.succeeded`, or a delivery that died): runs finished in the last
   * `RELEASE_RECONCILE_WINDOW_MS`, whose repo is linked to a project, with no release row or
   * no `deploy.released` event. One failing run is
   * logged and skipped; it is found again on the next pass. Returns how many it recorded.
   */
  async reconcile(now: Date): Promise<number> {
    const candidates = await this.deps.releases.findUnrecorded({
      state: RunStates.succeeded,
      since: new Date(now.getTime() - RELEASE_RECONCILE_WINDOW_MS),
      eventDedupePrefix: governanceDedupeKey(DomainEventTypes.deployReleased, ''),
      limit: RELEASE_RECONCILE_BATCH_SIZE,
    });
    // One at a time, oldest first: production's pool is a single connection, and an older
    // release must exist before a newer one names it as `previousReleaseSha`.
    return await candidates.reduce(async (previous, candidate) => {
      const recorded = await previous;
      try {
        const result = await this.recordRun(candidate.workspaceId, candidate.runId);
        return result === undefined ? recorded : recorded + 1;
      } catch (error) {
        console.error(`[releases] reconciling run ${candidate.runId} failed`, error);
        return recorded;
      }
    }, Promise.resolve(0));
  }

  /** A project's releases, newest first. */
  async listForProject(workspaceId: string, projectId: string, filter: { limit: number; before?: Date }) {
    return await this.deps.releases.listByProject(workspaceId, projectId, filter);
  }
}
