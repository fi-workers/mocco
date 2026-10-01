import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { ExecutorIds } from '@mocco/common/execution';
import { WorkspaceMemberRoles } from '@mocco/common/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { createTestEventBus } from '@backend/domain/events/testing/event-bus';
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
import { members } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';
import { contextServices } from '@backend/transport/trpc/testing/context-services';

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

describe('apiKey router on pglite', () => {
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

  const makeAudit = (): AuditService => new AuditService({ audit: new AuditRepo(t.db) });

  const makeRuns = (): RunService =>
    new RunService({
      bus: createTestEventBus(t.db),
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits: new CommitRepo(t.db),
      configs: new CommitConfigRepo(t.db),
      executors: new Map([[ExecutorIds.generic, new FakeExecutor()]]),
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      audit: makeAudit(),
      waitUntil: () => {
        /* api key router tests don't exercise the run loop */
      },
    });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = makeRuns();
    const roles = new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) });
    const gates = new GateService({
      bus: createTestEventBus(t.db),
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
      audit: makeAudit(),
    });
    const grants = new GrantService({ grants: new CredentialGrantRepo(t.db) });
    const ctx = {
      ...contextServices(t.db),
      auth,
      workspace,
      runs,
      roles,
      gates,
      grants,
      audit: makeAudit(),
      session,
      headers,
    };
    return { api: appRouter.createCaller(ctx), ctx, userId: session?.user.id ?? '' };
  };

  const setup = async () => {
    const owner = await signedInCaller('owner@example.com');
    const { workspace: ws } = await owner.api.workspace.create({ name: 'W' });
    const { project } = await owner.api.project.create({ workspaceId: ws.id, name: 'Acme', handle: 'acme' });
    return { owner, workspaceId: ws.id, projectId: project.id };
  };

  it('creates a key (token once), lists it without the token, and revokes it', async () => {
    const { owner, workspaceId, projectId } = await setup();

    const created = await owner.api.apiKey.create({
      workspaceId,
      projectId,
      kind: ApiKeyKinds.secret,
      name: 'CI',
      scopes: [ApiScopes.otaWrite],
    });
    const listed = await owner.api.apiKey.list({ workspaceId, projectId });

    expect(created.token).toMatch(/^mk_sec_/u);
    expect(listed.keys.map(key => key.id)).toEqual([created.key.id]);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    await owner.api.apiKey.revoke({ workspaceId, projectId, keyId: created.key.id });
    const after = await owner.api.apiKey.list({ workspaceId, projectId });
    expect(after.keys[0]?.revokedAt).not.toBeNull();
  });

  it('refuses a publishable key with a write scope', async () => {
    const { owner, workspaceId, projectId } = await setup();
    await expect(
      owner.api.apiKey.create({
        workspaceId,
        projectId,
        kind: ApiKeyKinds.publishable,
        name: 'web',
        scopes: [ApiScopes.otaWrite],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('lets a plain member list keys but not create or revoke them', async () => {
    const { owner, workspaceId, projectId } = await setup();
    const created = await owner.api.apiKey.create({
      workspaceId,
      projectId,
      kind: ApiKeyKinds.publishable,
      name: 'web',
      scopes: [ApiScopes.flagsRead],
    });
    const member = await signedInCaller('member@example.com');
    await t.db
      .insert(members)
      .values({ organizationId: workspaceId, userId: member.userId, role: WorkspaceMemberRoles.member });

    const listed = await member.api.apiKey.list({ workspaceId, projectId });
    expect(listed.keys).toHaveLength(1);
    await expect(
      member.api.apiKey.create({
        workspaceId,
        projectId,
        kind: ApiKeyKinds.secret,
        name: 'x',
        scopes: [ApiScopes.otaWrite],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(member.api.apiKey.revoke({ workspaceId, projectId, keyId: created.key.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it("hides another workspace's project (NOT_FOUND)", async () => {
    const { workspaceId, projectId } = await setup();
    const stranger = await signedInCaller('stranger@example.com');
    await expect(stranger.api.apiKey.list({ workspaceId, projectId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
