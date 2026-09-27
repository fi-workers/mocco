// What every governance domain event says about its run (catalog: @mocco/common/events).
// Shared by RunService (run.*, gate.pending) and GateService (gate.resumed/rejected), so
// both describe a run the same way.
import { moccoConfigSchema } from '@mocco/common/mocco-config';

import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { DomainEventType } from '@mocco/common/events';

/** `subject_type` values of governance events. */
export const EventSubjectTypes = {
  run: 'run',
  runGate: 'run_gate',
} as const;

/**
 * The dedupe key of a governance event: `<type>:<subject id>` (`run.failed:<runId>`,
 * `gate.pending:<gateId>`). Each fact happens once per run or gate, so two concurrent
 * callbacks or votes that both reach the transition publish one event, not two.
 */
export function governanceDedupeKey(type: DomainEventType, subjectId: string): string {
  return `${type}:${subjectId}`;
}

/** App-relative path of the run page (the frontend's `/workspaces/[id]/runs/[runId]`). */
export function runPagePath(workspaceId: string, runId: string): string {
  return `/workspaces/${workspaceId}/runs/${runId}`;
}

/** The run-subject part of a governance event payload, loaded in one query. */
export async function loadRunEventSubject(runs: RunRepo, workspaceId: string, runId: string) {
  const { run, repo, commit, config, triggeredBy } = await runs.getWithContextInWorkspace(workspaceId, runId);
  const repoFullName = `${repo.owner}/${repo.name}`;
  // The pinned snapshot is a validated config (a run can't start otherwise); parse it
  // through the SSOT rather than trusting the jsonb shape.
  const pipelineName = moccoConfigSchema.parse(config.parsedJson).pipeline;
  return {
    workspaceId,
    runId,
    repoFullName,
    pipelineName,
    commitSha: commit.sha,
    linkPath: runPagePath(workspaceId, runId),
    triggeredByUserId: run.triggeredByUserId,
    triggeredByName: triggeredBy?.name ?? null,
    facts: { repo: repoFullName, pipeline: pipelineName },
  };
}
