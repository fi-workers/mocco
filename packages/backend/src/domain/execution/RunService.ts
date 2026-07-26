import { createHash, randomBytes } from 'node:crypto';

import { moccoConfigSchema } from '@mocco/common/mocco-config';

import { ConfigNotRunnableError, RunNotFoundError } from '@backend/domain/execution/errors';
import { CommitNotFoundError } from '@backend/domain/integration/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import type { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import type { CommitRepo } from '@backend/domain/integration/repos/commit.repo';

/** Byte length of the opaque per-run callback token. 32 bytes = 256 bits of entropy. */
const CALLBACK_TOKEN_BYTES = 32;

/** Run-event types this service emits. Kept local — the wire schema (`runEventSchema`)
 * carries `type` as a free-form string; the executor loop (PR3) adds the rest. */
const RunEventTypes = { runCreated: 'run.created' } as const;

export interface RunServiceDeps {
  runs: RunRepo;
  steps: RunStepRepo;
  events: RunEventRepo;
  commits: CommitRepo;
  configs: CommitConfigRepo;
}

/** The sha-256 hash (hex) of an opaque token — what we store; the plaintext is never persisted. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Owns run policy: turning a commit candidate into a Run pinned to its config
 * snapshot, plus the workspace-scoped read paths. Anemic domain (ADR 0012) —
 * reaches the DB only through repos, maps their `EntityNotFoundError` to a
 * domain error, and narrows to the wire shape via `.output` at the router.
 *
 * PR2 scope: `trigger` (materialize + create, no dispatch), `get`, `observe`.
 * The executor loop (`applyCallback` + dispatch) lands in PR3.
 */
export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  /** A commit owned by the workspace, or throw CommitNotFoundError. A commit is
   * NEVER resolved by id alone — always through the workspace-scoped repo join.
   * Mirrors CommitConfigService.requireCommit. */
  private async requireCommit(workspaceId: string, commitId: string) {
    try {
      return await this.deps.commits.getByIdInWorkspace(workspaceId, commitId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new CommitNotFoundError(commitId, { cause: error });
      }
      throw error;
    }
  }

  /** A run owned by the workspace, or throw RunNotFoundError. */
  private async requireRun(workspaceId: string, runId: string) {
    try {
      return await this.deps.runs.getByIdInWorkspace(workspaceId, runId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new RunNotFoundError(runId, { cause: error });
      }
      throw error;
    }
  }

  /**
   * Create a run for a commit candidate, pinned to its config snapshot.
   *
   * Guards the config is `present && valid` (else `ConfigNotRunnableError`),
   * materializes the run's steps from the pinned `MoccoConfig` definition, and
   * appends a `run.created` event. Does NOT dispatch/execute — PR3 threads the
   * plaintext callback token to the executor; here only its sha-256 is stored.
   */
  async trigger(workspaceId: string, commitId: string, userId: string) {
    // Resolve workspace-scoped for its authorization side effect (throws
    // CommitNotFoundError for a foreign/unknown commit) — the row itself is
    // unused; the pinned definition comes from the config snapshot below.
    await this.requireCommit(workspaceId, commitId);

    const snapshot = await this.deps.configs.findByCommitId(commitId);
    if (snapshot === undefined || !snapshot.present || !snapshot.valid) {
      throw new ConfigNotRunnableError(commitId);
    }

    // The stored parsedJson is already a validated MoccoConfig, but re-parse it
    // through the zod SSOT to recover typed steps (never trust the raw jsonb shape).
    const config = moccoConfigSchema.parse(snapshot.parsedJson);

    // Mint the opaque per-run callback token; store only its hash. The plaintext
    // is unused in PR2 (no dispatch yet) — PR3 returns it once to thread to the executor.
    const callbackToken = randomBytes(CALLBACK_TOKEN_BYTES).toString('hex');

    const run = await this.deps.runs.create({
      workspaceId,
      commitId,
      commitConfigId: snapshot.id,
      state: 'queued',
      currentIndex: 0,
      callbackTokenHash: hashToken(callbackToken),
      triggeredByUserId: userId,
      triggerSource: 'manual',
    });

    await this.deps.steps.insertMany(
      config.steps.map((step, index) => ({
        workspaceId,
        runId: run.id,
        stepIndex: index,
        name: step.run,
        executor: step.executor,
        with: step.with ?? null,
        status: 'pending',
      })),
    );

    await this.deps.events.append({
      workspaceId,
      runId: run.id,
      type: RunEventTypes.runCreated,
      payload: { commitId, stepCount: config.steps.length },
    });

    return run;
  }

  /** A run and its materialized steps, workspace-scoped. */
  async get(workspaceId: string, runId: string) {
    const run = await this.requireRun(workspaceId, runId);
    const steps = await this.deps.steps.listByRun(workspaceId, runId);
    return { run, steps };
  }

  /** A run plus its progression events with `seq > sinceSeq` — the live poll read. */
  async observe(workspaceId: string, runId: string, sinceSeq: bigint) {
    const run = await this.requireRun(workspaceId, runId);
    const events = await this.deps.events.listSince(workspaceId, runId, sinceSeq);
    return { run, events };
  }
}
