// The run tools over a real database.
//
// What matters here is not that a reader gets its rows — it is that a caller only ever
// sees the workspace they belong to, and that a tool without a signed-in person refuses
// rather than falling back to anything.
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { expectOne } from '@backend/infra/db/rows';
import {
  commitConfigs,
  commits,
  members,
  providerConnections,
  repos,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { getRun, searchRuns, userIdOf, MCP_USER_ID, type RunToolDeps } from '@backend/transport/mcp/tools/runs';

describe('mocco_runs_* (pglite)', () => {
  let t: TestDb;
  let deps: RunToolDeps;
  let runs: RunRepo;
  let ada: string;
  let mine: string;
  let theirs: string;
  let myRepo: string;
  let theirRepo: string;

  async function addWorkspace(memberId?: string) {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    if (memberId !== undefined) {
      await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'owner' });
    }
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    const repoId = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: connection.id,
          externalRepoId: randomUUID(),
          owner: 'acme',
          name: randomUUID().slice(0, 6),
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
    return { workspaceId, repoId };
  }

  async function addRun(workspaceId: string, repoId: string, state?: 'awaiting_gate') {
    const commitId = expectOne(
      await t.db
        .insert(commits)
        .values({
          repoId,
          sha: randomUUID(),
          branch: 'main',
          message: 'fix the login button',
          authorName: 'Ada',
          authorEmail: 'ada@acme.test',
          committedAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning(),
    ).id;
    const commitConfigId = expectOne(
      await t.db
        .insert(commitConfigs)
        .values({ commitId, rawYaml: 'version: 1', parsedJson: { version: 1 }, valid: true })
        .returning(),
    ).id;
    return await runs.create({
      workspaceId,
      commitId,
      commitConfigId,
      callbackTokenHash: randomUUID(),
      ...(state !== undefined && { state }),
    });
  }

  beforeEach(async () => {
    t = await createTestDb();
    runs = new RunRepo(t.db);
    const steps = new RunStepRepo(t.db);
    const gates = new RunGateRepo(t.db);
    ada = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    ({ workspaceId: mine, repoId: myRepo } = await addWorkspace(ada));
    ({ workspaceId: theirs, repoId: theirRepo } = await addWorkspace());

    deps = {
      runs: {
        searchInWorkspace: async (...args) => await runs.searchInWorkspace(...args),
        get: async (workspaceId: string, runId: string) => {
          const run = await runs.getByIdInWorkspace(workspaceId, runId);
          return {
            run,
            steps: await steps.listByRun(workspaceId, runId),
            gates: await gates.findByRun(workspaceId, runId),
            // The tool ignores votes; the service returns them, so the stub is faithful.
            resumes: [],
          };
        },
      },
      scope: new WorkspaceScope({ memberships: new MembershipRepo(t.db) }),
    };
  });
  afterEach(async () => {
    await t.close();
  });

  it('finds the runs of the workspace the caller belongs to', async () => {
    const run = await addRun(mine, myRepo);

    const answer = await searchRuns(deps, { limit: 20, responseFormat: 'concise' }, ada);

    expect(answer.runs.map(each => each.id)).toEqual([run.id]);
  });

  it('never returns another workspace, even one holding runs', async () => {
    await addRun(theirs, theirRepo);

    const answer = await searchRuns(deps, { limit: 20, responseFormat: 'concise' }, ada);

    expect(answer.runs).toEqual([]);
  });

  it('refuses a workspace the caller is not in', async () => {
    await expect(searchRuns(deps, { workspaceId: theirs, limit: 20, responseFormat: 'concise' }, ada)).rejects.toThrow(
      /No workspace/u,
    );
  });

  it('refuses with no signed-in person rather than reading anything', async () => {
    // What the wiring hands a tool when the request carried no verified subject.
    expect(() => userIdOf({})).toThrow(/signed-in person/u);
    expect(() => userIdOf({ http: { authInfo: { extra: { [MCP_USER_ID]: '' } } } })).toThrow(/signed-in person/u);
  });

  it('filters by state, which is how "what is waiting" is asked', async () => {
    await addRun(mine, myRepo);
    const paused = await addRun(mine, myRepo, 'awaiting_gate');

    const answer = await searchRuns(deps, { state: 'awaiting_gate', limit: 20, responseFormat: 'concise' }, ada);

    expect(answer.runs.map(each => each.id)).toEqual([paused.id]);
  });

  it('keeps concise concise, and says more only when asked', async () => {
    await addRun(mine, myRepo);

    const concise = await searchRuns(deps, { limit: 20, responseFormat: 'concise' }, ada);
    const detailed = await searchRuns(deps, { limit: 20, responseFormat: 'detailed' }, ada);

    expect(concise.runs[0]).not.toHaveProperty('message');
    expect(detailed.runs[0]).toHaveProperty('message', 'fix the login button');
  });

  it('reads one run of the caller workspace', async () => {
    const run = await addRun(mine, myRepo);

    const answer = await getRun(deps, { runId: run.id, responseFormat: 'concise' }, ada);

    expect(answer.id).toBe(run.id);
    expect(answer.waitingOn).toBeNull();
  });

  it('will not read a run belonging to another workspace', async () => {
    const theirRun = await addRun(theirs, theirRepo);

    await expect(getRun(deps, { runId: theirRun.id, responseFormat: 'concise' }, ada)).rejects.toThrow();
  });
});
