import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { GateService } from '@backend/domain/governance/GateService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import { providerConnections, repos } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';

/** A create-grant input for the given workspace + repo. Module-scoped (captures
 * nothing) per unicorn/consistent-function-scoping. */
const grantInput = (workspaceId: string, repoId: string) => ({
  workspaceId,
  repoId,
  pipeline: 'deploy',
  gateName: 'prod-approval',
  provider: 'aws',
  role: 'deploy-role',
  maxTtlSeconds: 3600,
});

const signUpViaHttp = async (auth: AuthService, email: string) => {
  const response = await auth.handler(
    new Request('https://local.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'fixture-password-1', name: 'fixture-user' }),
    }),
  );
  return new Headers({ cookie: response.headers.get('set-cookie') ?? '' });
};

describe('credentialGrant router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  const makeRuns = (): RunService =>
    new RunService({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits: new CommitRepo(t.db),
      configs: new CommitConfigRepo(t.db),
      executors: new Map([[ExecutorIds.generic, new FakeExecutor()]]),
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      waitUntil: () => {
        /* grant router tests don't exercise the run loop */
      },
    });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = makeRuns();
    const roles = new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) });
    const gates = new GateService({
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
    });
    const grants = new GrantService({ grants: new CredentialGrantRepo(t.db) });
    return appRouter.createCaller({ auth, workspace, runs, roles, gates, grants, session, headers });
  };

  /** Seed a repo under a workspace (via a provider connection), returning its id. */
  const seedRepo = async (workspaceId: string): Promise<string> => {
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
  };

  describe('create / list / delete', () => {
    it('creates a grant and returns it (workspaceId present, no leak)', async () => {
      const api = await signedInCaller('create@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const repoId = await seedRepo(ws.id);

      const { grant } = await api.credentialGrant.create(grantInput(ws.id, repoId));
      expect(grant).toMatchObject({ workspaceId: ws.id, repoId, provider: 'aws', role: 'deploy-role' });

      const { grants } = await api.credentialGrant.list({ workspaceId: ws.id });
      expect(grants).toHaveLength(1);
      expect(grants[0]?.id).toBe(grant.id);
    });

    it('deletes a grant', async () => {
      const api = await signedInCaller('delete@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const repoId = await seedRepo(ws.id);
      const { grant } = await api.credentialGrant.create(grantInput(ws.id, repoId));

      await api.credentialGrant.delete({ workspaceId: ws.id, grantId: grant.id });
      const { grants } = await api.credentialGrant.list({ workspaceId: ws.id });
      expect(grants).toHaveLength(0);
    });

    it('deleting an unknown grant is NOT_FOUND', async () => {
      const api = await signedInCaller('delete-unknown@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await expect(api.credentialGrant.delete({ workspaceId: ws.id, grantId: randomUUID() })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('tenant isolation', () => {
    it('a non-member cannot list grants in another workspace (NOT_FOUND)', async () => {
      const owner = await signedInCaller('owner-list@example.com');
      const { workspace: wsA } = await owner.workspace.create({ name: 'A' });

      const stranger = await signedInCaller('stranger-list@example.com');
      await expect(stranger.credentialGrant.list({ workspaceId: wsA.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it("a grant belonging to another workspace maps to NOT_FOUND (deleting via B's workspaceId)", async () => {
      const ownerA = await signedInCaller('owner-a@example.com');
      const { workspace: wsA } = await ownerA.workspace.create({ name: 'A' });
      const repoId = await seedRepo(wsA.id);
      const { grant } = await ownerA.credentialGrant.create(grantInput(wsA.id, repoId));

      const memberB = await signedInCaller('member-b@example.com');
      const { workspace: wsB } = await memberB.workspace.create({ name: 'B' });

      await expect(memberB.credentialGrant.delete({ workspaceId: wsB.id, grantId: grant.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
