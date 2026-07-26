import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { expectOne } from '@backend/infra/db/rows';
import { commitConfigs, commits, providerConnections, repos, runs, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

interface Seed {
  workspaceId: string;
  runId: string;
}

describe('RunEventRepo (pglite)', () => {
  let t: TestDb;
  let runEventRepo: RunEventRepo;

  beforeEach(async () => {
    t = await createTestDb();
    runEventRepo = new RunEventRepo(t.db);
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

  it('append returns the row with an assigned bigint seq and stores the payload', async () => {
    const s = await seedRun();
    const event = await runEventRepo.append({
      workspaceId: s.workspaceId,
      runId: s.runId,
      type: 'run.created',
      payload: { note: 'hi' },
    });
    expect(typeof event.seq).toBe('bigint');
    expect(event.type).toBe('run.created');
    expect(event.payload).toEqual({ note: 'hi' });
  });

  it('listSince returns only events with seq greater than the cursor, oldest-first', async () => {
    const s = await seedRun();
    const first = await runEventRepo.append({ workspaceId: s.workspaceId, runId: s.runId, type: 'run.created' });
    const second = await runEventRepo.append({ workspaceId: s.workspaceId, runId: s.runId, type: 'step.dispatched' });
    const third = await runEventRepo.append({ workspaceId: s.workspaceId, runId: s.runId, type: 'step.succeeded' });

    // From the very start: all three, oldest-first.
    const all = await runEventRepo.listSince(s.workspaceId, s.runId, 0n);
    expect(all.map(e => e.seq)).toEqual([first.seq, second.seq, third.seq]);

    // Strictly after the first: only the later two.
    const after = await runEventRepo.listSince(s.workspaceId, s.runId, first.seq);
    expect(after.map(e => e.type)).toEqual(['step.dispatched', 'step.succeeded']);
  });

  it('listSince scopes to the run and the workspace', async () => {
    const s = await seedRun();
    await runEventRepo.append({ workspaceId: s.workspaceId, runId: s.runId, type: 'run.created' });

    // A different run in the same workspace.
    const otherRun = await seedRun();
    await runEventRepo.append({ workspaceId: otherRun.workspaceId, runId: otherRun.runId, type: 'run.created' });

    expect(await runEventRepo.listSince(s.workspaceId, s.runId, 0n)).toHaveLength(1);
    // A foreign workspace passing this run id sees nothing.
    const foreign = await seedRun();
    expect(await runEventRepo.listSince(foreign.workspaceId, s.runId, 0n)).toHaveLength(0);
  });
});
