import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import { providerConnections, repos, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createExtApp, type ExtDeps } from '@backend/transport/ext/app';

import type { DispatchContext, RunCallbackDto } from '@mocco/common/execution';
import type { MoccoConfig } from '@mocco/common/mocco-config';

const CALLBACK_URL = 'http://localhost:3100/api/ext/callback';

const VALID_CONFIG: MoccoConfig = {
  version: 1,
  pipeline: 'deploy',
  steps: [
    { run: 'build', executor: 'generic' },
    { run: 'test', executor: 'generic' },
  ],
};

interface PostedRequest {
  url: string;
  body: unknown;
}

async function post(app: ReturnType<typeof createExtApp>, path: string, body: unknown) {
  return await app.request(`/api/ext${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('ext execution routes (pglite)', () => {
  let t: TestDb;
  let pending: Promise<unknown>[];
  let posted: PostedRequest[];
  let executor: FakeExecutor;
  let runs: RunService;
  let commits: CommitRepo;
  let configs: CommitConfigRepo;

  beforeEach(async () => {
    t = await createTestDb();
    pending = [];
    posted = [];
    executor = new FakeExecutor();
    commits = new CommitRepo(t.db);
    configs = new CommitConfigRepo(t.db);
    runs = new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      commits,
      configs,
      executor,
      callbackUrl: CALLBACK_URL,
      waitUntil: p => {
        pending.push(p);
      },
    });
  });
  afterEach(async () => {
    await t.close();
  });

  /** Minimal ExtDeps — the GitHub-gated deps are omitted (optional); the execution
   * routes only need `runs`, `postJson`, and the waitUntil collector. */
  function deps(overrides: Partial<ExtDeps> = {}): ExtDeps {
    return {
      auth: new AuthService(createProvider(t.db, { secret: 'test-secret-not-for-prod' })),
      runs,
      callbackUrl: CALLBACK_URL,
      postJson: async (url, body) => {
        posted.push({ url, body });
      },
      webhookSecret: undefined,
      waitUntil: p => {
        pending.push(p);
      },
      ...overrides,
    };
  }

  /** Drain every deferred promise, including ones scheduled while draining (advance
   * dispatches more work). */
  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const p = pending.shift();
      // eslint-disable-next-line no-await-in-loop
      await p;
    }
  }

  /** Trigger a runnable run and return its id + the token handed to the executor. */
  async function startRun(): Promise<{ workspaceId: string; runId: string; token: string }> {
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
    const conn = expectOne(
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
          connectionId: conn.id,
          externalRepoId: randomUUID(),
          owner: 'fi-workers',
          name: 'api',
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
    await commits.upsertMany([
      {
        repoId,
        sha: `sha-${randomUUID()}`,
        branch: 'main',
        message: 'msg',
        authorName: 'A',
        authorEmail: 'a@example.com',
        committedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const commitRows = await commits.listByRepo(repoId, null, 1);
    const commitRow = commitRows[0];
    if (commitRow === undefined) {
      throw new Error('expected seeded commit');
    }
    await configs.upsert({
      commitId: commitRow.id,
      present: true,
      rawYaml: 'version: 1',
      parsedJson: VALID_CONFIG,
      valid: true,
      validationErrors: [],
    });
    const run = await runs.trigger(workspaceId, commitRow.id, userId);
    const token = executor.dispatches.at(-1)?.ctx.callbackToken;
    if (token === undefined) {
      throw new Error('expected the executor to be dispatched with a token');
    }
    return { workspaceId, runId: run.id, token };
  }

  describe('POST /callback', () => {
    it('funnels a valid callback to applyCallback and advances the run', async () => {
      const { workspaceId, runId, token } = await startRun();
      const app = createExtApp(deps());

      const body: RunCallbackDto = { runId, stepIndex: 0, status: 'succeeded', token };
      const res = await post(app, '/callback', body);
      expect(res.status).toBe(202);

      await drain();
      const detail = await runs.get(workspaceId, runId);
      expect(detail.steps[0]?.status).toBe('succeeded');
      expect(detail.run.currentIndex).toBe(1);
    });

    it('rejects a malformed body with 400 and no processing', async () => {
      await startRun();
      const app = createExtApp(deps());

      const res = await post(app, '/callback', { runId: 'not-a-uuid' });
      expect(res.status).toBe(400);
    });

    it('acks 202 for a wrong token but does not advance (rejection is swallowed)', async () => {
      const { workspaceId, runId } = await startRun();
      const app = createExtApp(deps());

      const res = await post(app, '/callback', { runId, stepIndex: 0, status: 'succeeded', token: 'wrong-token' });
      expect(res.status).toBe(202);

      await drain();
      const detail = await runs.get(workspaceId, runId);
      expect(detail.run.currentIndex).toBe(0);
      expect(detail.steps[0]?.status).toBe('dispatched');
    });
  });

  describe('POST /executor/generic', () => {
    it('posts running then succeeded callbacks, and IGNORES a caller-supplied callbackUrl (SSRF guard)', async () => {
      const app = createExtApp(deps());
      const ctx: DispatchContext = {
        runId: randomUUID(),
        stepIndex: 0,
        // A malicious caller-chosen target — the endpoint must NOT post here.
        callbackUrl: 'https://attacker.example/steal',
        callbackToken: 'a'.repeat(64),
      };

      const res = await post(app, '/executor/generic', ctx);
      expect(res.status).toBe(202);

      await drain();
      expect(posted).toHaveLength(2);
      // Both callbacks go to THIS deployment's own callback URL, never the body's.
      expect(posted.map(p => p.url)).toEqual([CALLBACK_URL, CALLBACK_URL]);
      expect(posted[0]).toMatchObject({
        body: { runId: ctx.runId, stepIndex: 0, status: 'running', token: ctx.callbackToken },
      });
      expect(posted[1]).toMatchObject({
        body: { runId: ctx.runId, stepIndex: 0, status: 'succeeded', token: ctx.callbackToken },
      });
    });

    it('rejects a malformed dispatch body with 400', async () => {
      const app = createExtApp(deps());
      const res = await post(app, '/executor/generic', { runId: randomUUID() });
      expect(res.status).toBe(400);
    });
  });
});
