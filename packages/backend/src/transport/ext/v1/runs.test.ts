// /v1/runs over HTTP: the scope and key-kind gates, the shape a caller gets, and the
// refusals. The project scoping itself is pinned in run.repo.project.test.ts; what matters
// here is that a key reaches it at all only with `runs:read`, only as a secret key, and
// that nothing on this surface can change a run.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { expectOne } from '@backend/infra/db/rows';
import {
  commitConfigs,
  commits,
  projectRepos,
  providerConnections,
  repos,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { type V1Env } from '@backend/transport/ext/v1/middleware';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import type { ApiScope } from '@mocco/common/apikey';

const URL_BASE = 'https://www.mocco.test/api/ext/v1';

describe('/v1/runs (pglite)', () => {
  let t: TestDb;
  let apiKeys: ApiKeyService;
  let workspaceId: string;
  let projectId: string;
  let userId: string;
  let repoId: string;
  let app: Hono<V1Env>;
  let runs: RunRepo;

  /** The project-scoped reads the route needs, straight off the repos. */
  const runReads = () => {
    const steps = new RunStepRepo(t.db);
    const gates = new RunGateRepo(t.db);
    return {
      searchInProject: async (...args: Parameters<RunRepo['searchInProject']>) => await runs.searchInProject(...args),
      getInProject: async (workspace: string, project: string, runId: string) => {
        const row = await runs.findInProject(workspace, project, runId);
        return row === undefined
          ? undefined
          : {
              ...row,
              steps: await steps.listByRun(workspace, runId),
              gates: await gates.findByRun(workspace, runId),
            };
      },
    };
  };

  const call = async (path: string, headers: Record<string, string> = {}) =>
    await app.fetch(new Request(`${URL_BASE}${path}`, { headers }));

  const keyOf = async (kind: (typeof ApiKeyKinds)[keyof typeof ApiKeyKinds], scopes: ApiScope[]) => {
    const { token } = await apiKeys.create(workspaceId, projectId, userId, {
      kind,
      name: kind,
      scopes,
      expiresAt: null,
      flagEnvironmentId: null,
    });
    return token;
  };

  const asReader = async () => ({
    authorization: `Bearer ${await keyOf(ApiKeyKinds.secret, [ApiScopes.runsRead])}`,
  });

  async function addRun() {
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
    return await runs.create({ workspaceId, commitId, commitConfigId, callbackTokenHash: randomUUID() });
  }

  beforeEach(async () => {
    t = await createTestDb();
    runs = new RunRepo(t.db);
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const { projects } = createProjectDomain(t.db);
    apiKeys = createApiKeyService(t.db, { projects, audit });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    repoId = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: connection.id,
          externalRepoId: randomUUID(),
          owner: 'acme',
          name: 'web',
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
    await t.db.insert(projectRepos).values({ workspaceId, projectId, repoId });
    app = new Hono<V1Env>()
      .basePath('/api/ext')
      .route('/v1', createV1Routes({ apiKeys, limiter: new MemoryRateLimiter(), runs: { runs: runReads() } }));
  });
  afterEach(async () => {
    await t.close();
  });

  it('lists the project runs with the commit that produced each', async () => {
    const run = await addRun();

    const response = await call('/runs', await asReader());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: { id: string; commit: { message: string } }[] };
    expect(body.runs.map(each => each.id)).toEqual([run.id]);
    expect(body.runs[0]?.commit.message).toBe('fix the login button');
  });

  it('refuses a key without runs:read', async () => {
    const response = await call('/runs', {
      authorization: `Bearer ${await keyOf(ApiKeyKinds.secret, [ApiScopes.otaRead])}`,
    });

    expect(response.status).toBe(403);
  });

  it('refuses a publishable key: run history is not for a browser or an app', async () => {
    // A publishable key may not even hold runs:read, so this is refused twice over.
    const response = await call('/runs', {
      authorization: `Bearer ${await keyOf(ApiKeyKinds.publishable, [ApiScopes.otaRead])}`,
    });

    expect(response.status).toBe(403);
  });

  it('refuses no key at all', async () => {
    const response = await call('/runs');

    expect(response.status).toBe(401);
  });

  it('answers a bad filter with 400 rather than ignoring it', async () => {
    const response = await call('/runs?state=not-a-state', await asReader());

    expect(response.status).toBe(400);
  });

  it('caps the page size', async () => {
    const response = await call('/runs?limit=1000', await asReader());

    expect(response.status).toBe(400);
  });

  it('returns one run with its steps and gates', async () => {
    const run = await addRun();

    const response = await call(`/runs/${run.id}`, await asReader());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; steps: unknown[]; gates: unknown[] };
    expect(body.id).toBe(run.id);
    expect(body.steps).toEqual([]);
    expect(body.gates).toEqual([]);
  });

  it('answers 404 for an unknown run, telling the caller nothing about other projects', async () => {
    const response = await call(`/runs/${randomUUID()}`, await asReader());

    expect(response.status).toBe(404);
  });

  it('never caches a run: its state is the thing being watched', async () => {
    const run = await addRun();

    const response = await call(`/runs/${run.id}`, await asReader());

    expect(response.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('exposes no way to change a run', async () => {
    const run = await addRun();
    const headers = await asReader();

    const posted = await app.fetch(new Request(`${URL_BASE}/runs/${run.id}`, { method: 'POST', headers }));

    expect(posted.status).toBe(404);
  });
});
