import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { expectOne } from '@backend/infra/db/rows';
import { commitConfigs, commits, providerConnections, repos, runs, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type * as schema from '@backend/infra/db/schema';

interface Seed {
  workspaceId: string;
  runId: string;
}

function stepValues(s: Seed, stepIndex: number, overrides: Partial<typeof schema.runSteps.$inferInsert> = {}) {
  return {
    workspaceId: s.workspaceId,
    runId: s.runId,
    stepIndex,
    name: `step-${stepIndex}`,
    executor: 'generic',
    ...overrides,
  };
}

describe('RunStepRepo (pglite)', () => {
  let t: TestDb;
  let runStepRepo: RunStepRepo;

  beforeEach(async () => {
    t = await createTestDb();
    runStepRepo = new RunStepRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedRun(): Promise<Seed> {
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const conn = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    const repoRow = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: conn.id,
          externalRepoId: randomUUID(),
          owner: 'o',
          name: 'n',
          defaultBranch: 'main',
        })
        .returning(),
    );
    const commitId = expectOne(
      await t.db
        .insert(commits)
        .values({
          repoId: repoRow.id,
          sha: randomUUID(),
          branch: 'main',
          message: 'm',
          authorName: 'a',
          authorEmail: 'a@example.com',
          committedAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning(),
    ).id;
    const commitConfigId = expectOne(
      await t.db.insert(commitConfigs).values({ commitId, rawYaml: 'version: 1', valid: true }).returning(),
    ).id;
    const runId = expectOne(
      await t.db
        .insert(runs)
        .values({ workspaceId, commitId, commitConfigId, callbackTokenHash: randomUUID() })
        .returning(),
    ).id;
    return { workspaceId, runId };
  }

  it('insertMany materializes steps and returns them; listByRun returns them in step order', async () => {
    const s = await seedRun();
    // Insert out of order to prove listByRun sorts by step_index.
    const inserted = await runStepRepo.insertMany([
      stepValues(s, 1, { with: { flag: true } }),
      stepValues(s, 0),
      stepValues(s, 2),
    ]);
    expect(inserted).toHaveLength(3);

    const rows = await runStepRepo.listByRun(s.workspaceId, s.runId);
    expect(rows.map(r => r.stepIndex)).toEqual([0, 1, 2]);
    expect(rows.every(r => r.status === 'pending')).toBe(true);
    expect(rows[1]?.with).toEqual({ flag: true });
    // `with` is nullable — a step without adapter options stores null.
    expect(rows[0]?.with).toBeNull();
  });

  it('insertMany with an empty list is a no-op that returns an empty array', async () => {
    const s = await seedRun();
    expect(await runStepRepo.insertMany([])).toEqual([]);
    expect(await runStepRepo.listByRun(s.workspaceId, s.runId)).toEqual([]);
  });

  it('listByRun scopes to the workspace', async () => {
    const s = await seedRun();
    await runStepRepo.insertMany([stepValues(s, 0)]);

    const foreign = await seedRun();
    expect(await runStepRepo.listByRun(foreign.workspaceId, s.runId)).toHaveLength(0);
  });
});
