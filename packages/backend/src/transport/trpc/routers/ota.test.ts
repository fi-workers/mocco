import { ExecutorIds } from '@mocco/common/execution';
import { Products } from '@mocco/common/project';
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

describe('ota router on pglite', () => {
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
        /* ota router tests don't exercise the run loop */
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

  const policyRules = {
    minSupportedVersion: '2.0.0',
    recommendedVersion: null,
    blockedVersions: [],
    messages: { en: { title: 'Update', body: 'Please update.', action: 'Update' } },
    storeUrl: null,
    softPromptIntervalHours: 72,
    approvalPolicy: null,
  };

  const setup = async (email: string) => {
    const caller = await signedInCaller(email);
    const { workspace: ws } = await caller.api.workspace.create({ name: 'W' });
    const { project } = await caller.api.project.create({ workspaceId: ws.id, name: 'Acme', handle: 'acme' });
    const { app } = await caller.api.project.addApp({
      workspaceId: ws.id,
      projectId: project.id,
      platform: 'android',
      name: 'Acme Android',
      bundleId: 'com.acme',
    });
    return { ...caller, scope: { workspaceId: ws.id, projectId: project.id, appId: app.id } };
  };

  it('is FORBIDDEN until the OTA product is enabled, then sets and reads a policy', async () => {
    const { api, scope } = await setup('ota@example.com');
    await expect(api.ota.versionPolicy.get(scope)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.ota });
    expect(await api.ota.versionPolicy.get(scope)).toEqual({ policy: null });

    await expect(
      api.ota.versionPolicy.change({ ...scope, rules: policyRules, storeLiveAttested: false }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const changed = await api.ota.versionPolicy.change({ ...scope, rules: policyRules, storeLiveAttested: true });
    expect(changed).toMatchObject({ outcome: 'applied', requestId: null });
    const { changes } = await api.ota.versionPolicy.history(scope);
    expect(changes).toHaveLength(1);
  });

  it('gates a tightening change through the approval router', async () => {
    const owner = await setup('ota-owner@example.com');
    await owner.api.product.enable({ workspaceId: owner.scope.workspaceId, product: Products.ota });
    const { role } = await owner.api.role.create({ workspaceId: owner.scope.workspaceId, name: 'release' });
    const gate = { resume: [{ role: 'release', count: 1 }], prevent_self: false, reason_required: false };
    await owner.api.ota.versionPolicy.change({
      ...owner.scope,
      rules: { ...policyRules, approvalPolicy: gate },
      storeLiveAttested: true,
    });

    const pending = await owner.api.ota.versionPolicy.change({
      ...owner.scope,
      rules: { ...policyRules, approvalPolicy: gate, minSupportedVersion: '2.1.0' },
      storeLiveAttested: true,
    });
    expect(pending.outcome).toBe('pending_approval');

    await owner.api.role.addMember({ workspaceId: owner.scope.workspaceId, roleId: role.id, userId: owner.userId });
    await owner.api.approval.vote({
      workspaceId: owner.scope.workspaceId,
      requestId: pending.requestId ?? '',
      decision: 'approve',
    });
    const { policy } = await owner.api.ota.versionPolicy.get(owner.scope);
    expect(policy).toMatchObject({ minSupportedVersion: '2.1.0', revision: 2 });
  });

  it("a project from another workspace is NOT_FOUND even with OTA enabled in the caller's own", async () => {
    const victim = await setup('victim@example.com');
    const attacker = await setup('attacker@example.com');
    await attacker.api.product.enable({ workspaceId: attacker.scope.workspaceId, product: Products.ota });

    await expect(
      attacker.api.ota.versionPolicy.get({ ...victim.scope, workspaceId: attacker.scope.workspaceId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      attacker.api.ota.versionPolicy.get({
        workspaceId: attacker.scope.workspaceId,
        projectId: attacker.scope.projectId,
        appId: victim.scope.appId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
