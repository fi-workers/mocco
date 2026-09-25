// What every governance domain event says about its run (catalog: @mocco/common/events).
// Shared by RunService (run.*, gate.pending) and GateService (gate.resumed/rejected), so
// both describe a run the same way.
import { moccoConfigSchema } from '@mocco/common/mocco-config';

import type { RunRepo } from '@backend/domain/execution/repos/run.repo';

/** `subject_type` values of governance events. */
export const EventSubjectTypes = {
  run: 'run',
  runGate: 'run_gate',
} as const;

/** App-relative path of the run page (the frontend's `/workspaces/[id]/runs/[runId]`). */
export function runPagePath(workspaceId: string, runId: string): string {
  return `/workspaces/${workspaceId}/runs/${runId}`;
}

/** The run-subject part of a governance event payload, loaded in one query. */
export async function loadRunEventSubject(runs: RunRepo, workspaceId: string, runId: string) {
  const { repo, commit, config } = await runs.getWithContextInWorkspace(workspaceId, runId);
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
    facts: { repo: repoFullName, pipeline: pipelineName },
  };
}
