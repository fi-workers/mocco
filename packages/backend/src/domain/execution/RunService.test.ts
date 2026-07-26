import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigNotRunnableError, RunNotFoundError } from '@backend/domain/execution/errors';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { CommitNotFoundError } from '@backend/domain/integration/errors';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import { providerConnections, repos, runEvents, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { MoccoConfig } from '@mocco/common/mocco-config';

const VALID_CONFIG: MoccoConfig = {
  version: 1,
  pipeline: 'deploy',
  steps: [
    { run: 'build', executor: 'generic' },
    { run: 'test', executor: 'generic', with: { flag: 'on' } },
  ],
};

describe('RunService (pglite)', () => {
  let t: TestDb;
  let commits: CommitRepo;
  let configs: CommitConfigRepo;
  let service: RunService;

  beforeEach(async () => {
    t = await createTestDb();
    commits = new CommitRepo(t.db);
    configs = new CommitConfigRepo(t.db);
    service = new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      commits,
      configs,
    });
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(name = 'W'): Promise<string> {
    return expectOne(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  /** A real user row — runs.triggered_by_user_id FKs mocco_users (a random uuid violates it). */
  async function seedUser(): Promise<string> {
    return expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
  }

  async function seedRepo(workspaceId: string): Promise<string> {
    const conn = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    return expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: conn.id,
          externalRepoId: randomUUID(),
          owner: 'fi-workers',
          name: 'api',
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
  }

  async function seedCommit(repoId: string, sha: string): Promise<string> {
    await commits.upsertMany([
      {
        repoId,
        sha,
        branch: 'main',
        message: `msg ${sha}`,
        authorName: 'Author',
        authorEmail: 'author@example.com',
        committedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const [row] = await commits.listByRepo(repoId, null, 1);
    if (row === undefined) {
      throw new Error('expected seeded commit row');
    }
    return row.id;
  }

  /** Seed a config snapshot for a commit. Defaults to a runnable (present+valid) config. */
  async function seedConfig(
    commitId: string,
    overrides: Partial<Parameters<CommitConfigRepo['upsert']>[0]> = {},
  ): Promise<void> {
    await configs.upsert({
      commitId,
      present: true,
      rawYaml: 'version: 1',
      parsedJson: VALID_CONFIG,
      valid: true,
      validationErrors: [],
      ...overrides,
    });
  }

  /** A workspace with a repo and one commit, returning both ids. */
  async function seedCommitInWorkspace(): Promise<{ workspaceId: string; commitId: string }> {
    const workspaceId = await seedWorkspace();
    const repoId = await seedRepo(workspaceId);
    const commitId = await seedCommit(repoId, `sha-${randomUUID()}`);
    return { workspaceId, commitId };
  }

  describe('trigger', () => {
    it('creates a queued run and materializes steps from the pinned config', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      expect(run.state).toBe('queued');
      expect(run.currentIndex).toBe(0);
      expect(run.commitId).toBe(commitId);
      expect(run.triggerSource).toBe('manual');

      const { steps } = await service.get(workspaceId, run.id);
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ stepIndex: 0, name: 'build', executor: 'generic', status: 'pending' });
      expect(steps[0]?.with).toBeNull();
      expect(steps[1]).toMatchObject({ stepIndex: 1, name: 'test', executor: 'generic', status: 'pending' });
      expect(steps[1]?.with).toEqual({ flag: 'on' });
    });

    it('stores only the sha-256 hash of the callback token, never a plaintext', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      // The raw row carries the hash (the wire schema strips it); it is a 64-char hex digest.
      expect(run.callbackTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('appends a run.created event carrying the step count', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      const { events } = await service.observe(workspaceId, run.id, 0n);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('run.created');
      expect(events[0]?.payload).toMatchObject({ commitId, stepCount: 2 });
    });

    it('does NOT dispatch — no step leaves pending (PR3 runs the loop)', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);

      const run = await service.trigger(workspaceId, commitId, await seedUser());

      const { steps } = await service.get(workspaceId, run.id);
      expect(steps.every(step => step.status === 'pending')).toBe(true);
      // The only event is run.created — nothing dispatched.
      const allEvents = await t.db.select().from(runEvents);
      expect(allEvents.map(event => event.type)).toEqual(['run.created']);
    });

    it('rejects a commit whose config snapshot is absent (present:false) with ConfigNotRunnableError', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId, { present: false, valid: false, parsedJson: null });

      await expect(service.trigger(workspaceId, commitId, await seedUser())).rejects.toBeInstanceOf(
        ConfigNotRunnableError,
      );
    });

    it('rejects a commit whose config snapshot is invalid (valid:false) with ConfigNotRunnableError', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId, {
        valid: false,
        parsedJson: null,
        validationErrors: [{ path: 'steps', message: 'too small', code: 'too_small' }],
      });

      await expect(service.trigger(workspaceId, commitId, await seedUser())).rejects.toBeInstanceOf(
        ConfigNotRunnableError,
      );
    });

    it('rejects a commit that has never been snapshotted with ConfigNotRunnableError', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();

      await expect(service.trigger(workspaceId, commitId, await seedUser())).rejects.toBeInstanceOf(
        ConfigNotRunnableError,
      );
    });

    it('rejects a commit in another workspace with CommitNotFoundError', async () => {
      const { commitId } = await seedCommitInWorkspace();
      const otherWorkspaceId = await seedWorkspace('other');

      await expect(service.trigger(otherWorkspaceId, commitId, await seedUser())).rejects.toBeInstanceOf(
        CommitNotFoundError,
      );
    });
  });

  describe('get', () => {
    it('throws RunNotFoundError for an unknown run', async () => {
      const workspaceId = await seedWorkspace();
      await expect(service.get(workspaceId, randomUUID())).rejects.toBeInstanceOf(RunNotFoundError);
    });

    it('throws RunNotFoundError for a run in another workspace (tenant isolation)', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);
      const run = await service.trigger(workspaceId, commitId, await seedUser());
      const otherWorkspaceId = await seedWorkspace('other');

      await expect(service.get(otherWorkspaceId, run.id)).rejects.toBeInstanceOf(RunNotFoundError);
    });
  });

  describe('observe', () => {
    it('returns only events newer than sinceSeq', async () => {
      const { workspaceId, commitId } = await seedCommitInWorkspace();
      await seedConfig(commitId);
      const run = await service.trigger(workspaceId, commitId, await seedUser());

      const all = await service.observe(workspaceId, run.id, 0n);
      expect(all.events).toHaveLength(1);
      const latestSeq = all.events[0]?.seq ?? 0n;

      const sinceLatest = await service.observe(workspaceId, run.id, latestSeq);
      expect(sinceLatest.events).toHaveLength(0);
      expect(sinceLatest.run.id).toBe(run.id);
    });
  });
});
