import { randomUUID } from 'node:crypto';

import { ExecutorIds, RunStates, RunStepStatuses, TriggerSources } from '@mocco/common/execution';
import { GateStates } from '@mocco/common/governance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { CredentialBroker } from '@backend/domain/credential/CredentialBroker';
import { StubCredentialProvider } from '@backend/domain/credential/providers/stub';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { hashToken } from '@backend/domain/execution/callback-token';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import {
  commitConfigs,
  commits,
  providerConnections,
  repos,
  runGates,
  runs,
  runSteps,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createExtApp, type ExtDeps } from '@backend/transport/ext/app';

import type { GateRequirements } from '@mocco/common/governance';
import type { MoccoConfig } from '@mocco/common/mocco-config';

const CALLBACK_URL = 'http://localhost:3100/api/ext/callback';
const TOKEN = 'b'.repeat(64);
const STEP_INDEX = 1;

const CONFIG: MoccoConfig = {
  version: 2,
  pipeline: 'deploy',
  steps: [
    { kind: 'gate', name: 'approve', resume: [{ role: 'lead', count: 1 }] },
    {
      kind: 'step',
      run: 'deploy',
      executor: 'generic',
      credential: { provider: 'aws', role: 'deployer', ttl: 900, gate: 'approve' },
    },
  ],
};

const GATE_REQUIREMENTS: GateRequirements = {
  resume: [{ role: 'lead', count: 1 }],
  prevent_self: false,
  reason_required: false,
};

async function post(app: ReturnType<typeof createExtApp>, path: string, body: unknown) {
  return await app.request(`/api/ext${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('ext POST /credentials (pglite)', () => {
  let t: TestDb;
  let broker: CredentialBroker;

  beforeEach(async () => {
    t = await createTestDb();
    broker = new CredentialBroker({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      runGates: new RunGateRepo(t.db),
      configs: new CommitConfigRepo(t.db),
      commits: new CommitRepo(t.db),
      grants: new CredentialGrantRepo(t.db),
      provider: new StubCredentialProvider(),
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  /** Seed an ALLOW-eligible run (gate resumed, step dispatched, matching grant). */
  async function seedAllow(): Promise<string> {
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
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
    const commit = expectOne(
      await t.db
        .insert(commits)
        .values({
          repoId,
          sha: `sha-${randomUUID()}`,
          branch: 'main',
          message: 'msg',
          authorName: 'A',
          authorEmail: 'a@example.com',
          committedAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning(),
    );
    const configRow = expectOne(
      await t.db
        .insert(commitConfigs)
        .values({
          commitId: commit.id,
          present: true,
          rawYaml: 'version: 2',
          parsedJson: CONFIG,
          valid: true,
          validationErrors: [],
        })
        .returning(),
    );
    const run = expectOne(
      await t.db
        .insert(runs)
        .values({
          workspaceId,
          commitId: commit.id,
          commitConfigId: configRow.id,
          state: RunStates.running,
          currentIndex: STEP_INDEX,
          callbackTokenHash: hashToken(TOKEN),
          triggerSource: TriggerSources.manual,
        })
        .returning(),
    );
    await t.db.insert(runSteps).values({
      workspaceId,
      runId: run.id,
      stepIndex: STEP_INDEX,
      name: 'deploy',
      executor: 'generic',
      status: RunStepStatuses.dispatched,
    });
    await t.db.insert(runGates).values({
      workspaceId,
      runId: run.id,
      itemIndex: 0,
      name: 'approve',
      state: GateStates.resumed,
      requirements: GATE_REQUIREMENTS,
    });
    await new CredentialGrantRepo(t.db).create({
      workspaceId,
      repoId,
      pipeline: 'deploy',
      gateName: 'approve',
      provider: 'aws',
      role: 'deployer',
      maxTtlSeconds: 3600,
    });
    return run.id;
  }

  function deps(): ExtDeps {
    const runService = new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits: new CommitRepo(t.db),
      configs: new CommitConfigRepo(t.db),
      executors: new Map([[ExecutorIds.generic, new FakeExecutor()]]),
      callbackUrl: CALLBACK_URL,
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      waitUntil: () => {
        /* the credentials route never defers */
      },
    });
    return {
      auth: new AuthService(createProvider(t.db, { secret: 'test-secret-not-for-prod' })),
      runs: runService,
      broker,
      callbackUrl: CALLBACK_URL,
      postJson: async () => {
        /* the credentials route never posts */
      },
      webhookSecret: undefined,
      waitUntil: () => {
        /* the credentials route never defers */
      },
    };
  }

  it('returns 200 with the issued credentials on the all-checks-pass path', async () => {
    const runId = await seedAllow();
    const app = createExtApp(deps());

    const res = await post(app, '/credentials', { runId, stepIndex: STEP_INDEX, token: TOKEN });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { credentials: { provider: string; role: string; value: string } };
    expect(payload.credentials.provider).toBe('aws');
    expect(payload.credentials.role).toBe('deployer');
    expect(payload.credentials.value).toBe('stub-credential');
  });

  it('returns a generic 403 (no leaked reason) on a denied request', async () => {
    const runId = await seedAllow();
    const app = createExtApp(deps());

    const res = await post(app, '/credentials', { runId, stepIndex: STEP_INDEX, token: 'wrong-token' });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('denied');
  });

  it('returns 403 for a malformed body (fail-closed, same generic response)', async () => {
    const app = createExtApp(deps());

    const res = await post(app, '/credentials', { runId: 'not-a-uuid' });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('denied');
  });
});
