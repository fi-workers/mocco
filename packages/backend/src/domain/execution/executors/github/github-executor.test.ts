import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GITHUB_RUN_STEP_EVENT_TYPE, GitHubExecutor } from '@backend/domain/execution/executors/github/provider';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { expectOne } from '@backend/infra/db/rows';
import { commitConfigs, commits, providerConnections, repos, runs, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { RunStepDispatch } from '@backend/domain/execution/ports';
import type { RepositoryDispatcher } from '@backend/domain/integration/ports';
import type { DispatchContext } from '@mocco/common/execution';

interface RecordedDispatch {
  ref: { externalAccountId: string; owner: string; name: string };
  eventType: string;
  clientPayload: Record<string, unknown>;
}

/** Plain object implementing the RepositoryDispatcher port — records instead of
 * firing a real repository_dispatch (no vi.mock, mirrors the integration fakes). */
class FakeRepositoryDispatcher implements RepositoryDispatcher {
  readonly calls: RecordedDispatch[] = [];

  async dispatch(
    ref: { externalAccountId: string; owner: string; name: string },
    eventType: string,
    clientPayload: Record<string, unknown>,
  ): Promise<void> {
    this.calls.push({ ref, eventType, clientPayload });
  }
}

const CALLBACK_URL = 'http://localhost:3100/api/ext/callback';

const DISPATCH: RunStepDispatch = { index: 0, name: 'build', executor: 'github-actions', with: null };

function ctxFor(runId: string, stepIndex = 0): DispatchContext {
  return { runId, stepIndex, callbackUrl: CALLBACK_URL, callbackToken: 'tok-123' };
}

describe('GitHubExecutor (pglite)', () => {
  let t: TestDb;
  let dispatcher: FakeRepositoryDispatcher;
  let executor: GitHubExecutor;

  beforeEach(async () => {
    t = await createTestDb();
    dispatcher = new FakeRepositoryDispatcher();
    executor = new GitHubExecutor({
      dispatcher,
      runs: new RunRepo(t.db),
      commits: new CommitRepo(t.db),
      repos: new RepoRepo(t.db),
      connections: new ProviderConnectionRepo(t.db),
    });
  });

  afterEach(async () => {
    await t.close();
  });

  /** Seed a full run→commit→repo→connection chain and return the run id + the
   * resolved fields the dispatch is expected to carry. */
  async function seedRun(overrides: { owner?: string; name?: string; externalAccountId?: string; sha?: string } = {}) {
    const owner = overrides.owner ?? 'fi-workers';
    const name = overrides.name ?? 'api';
    const externalAccountId = overrides.externalAccountId ?? '424242';
    const sha = overrides.sha ?? `sha-${randomUUID()}`;

    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const connectionId = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId, accountLogin: owner })
        .returning(),
    ).id;
    const repoId = expectOne(
      await t.db
        .insert(repos)
        .values({ workspaceId, connectionId, externalRepoId: randomUUID(), owner, name, defaultBranch: 'main' })
        .returning(),
    ).id;
    const commitId = expectOne(
      await t.db
        .insert(commits)
        .values({
          repoId,
          sha,
          branch: 'main',
          message: 'msg',
          authorName: 'Author',
          authorEmail: 'author@example.com',
          committedAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning(),
    ).id;
    const commitConfigId = expectOne(
      await t.db
        .insert(commitConfigs)
        .values({ commitId, present: true, rawYaml: 'version: 1', parsedJson: null, valid: true })
        .returning(),
    ).id;
    const runId = expectOne(
      await t.db
        .insert(runs)
        .values({
          workspaceId,
          commitId,
          commitConfigId,
          state: 'running',
          currentIndex: 0,
          callbackTokenHash: 'a'.repeat(64),
        })
        .returning(),
    ).id;

    return { runId, owner, name, externalAccountId, sha };
  }

  it('resolves the run and fires repository_dispatch with the correct ref + client_payload', async () => {
    const { runId, owner, name, externalAccountId, sha } = await seedRun();

    const result = await executor.start(DISPATCH, ctxFor(runId, 2));

    expect(dispatcher.calls).toHaveLength(1);
    const [call] = dispatcher.calls;
    expect(call?.ref).toEqual({ externalAccountId, owner, name });
    expect(call?.eventType).toBe(GITHUB_RUN_STEP_EVENT_TYPE);
    expect(call?.clientPayload).toEqual({
      runId,
      stepIndex: 2,
      commitSha: sha,
      callbackUrl: CALLBACK_URL,
      callbackToken: 'tok-123',
    });
    // The opaque handle names the target repo + run/step position.
    expect(result.handle).toBe(`github:${owner}/${name}:${runId}:2`);
  });

  it('carries the resolved installation id and owner/name from the seeded chain', async () => {
    const { runId, owner, name, externalAccountId } = await seedRun({
      owner: 'acme',
      name: 'web',
      externalAccountId: '99',
    });

    await executor.start(DISPATCH, ctxFor(runId));

    expect(dispatcher.calls[0]?.ref).toEqual({ externalAccountId, owner, name });
  });

  it('throws for an unknown run id (invariant breach — the run is committed before dispatch)', async () => {
    await expect(executor.start(DISPATCH, ctxFor(randomUUID()))).rejects.toThrow(/was not found/);
    expect(dispatcher.calls).toHaveLength(0);
  });
});
