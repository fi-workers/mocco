import { AuditActions } from '@mocco/common/audit';
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
import { auditLog } from '@backend/infra/db/schema';
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

describe('flags router on pglite', () => {
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
        /* flags tests don't exercise the run loop */
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

  const setup = async (email = 'owner@example.com') => {
    const owner = await signedInCaller(email);
    const { workspace: ws } = await owner.api.workspace.create({ name: 'W' });
    const { project } = await owner.api.project.create({ workspaceId: ws.id, name: 'Acme', handle: 'acme' });
    return { ...owner, scope: { workspaceId: ws.id, projectId: project.id } };
  };

  it('requires the flags product to be enabled', async () => {
    const { api, scope } = await setup();

    await expect(api.flags.list(scope)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('creates environments and flags, toggles a flag and serves the new ruleset', async () => {
    const { api, scope } = await setup();
    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.flags });

    const { environment } = await api.flags.createEnvironment({ ...scope, key: 'production', name: 'Production' });
    await api.flags.createBoolean({ ...scope, key: 'new-checkout' });
    const { changeset } = await api.flags.applyChangeset({
      ...scope,
      environmentId: environment.id,
      baseVersion: 1,
      ops: [{ op: 'set_enabled', flagKey: 'new-checkout', enabled: true }],
    });
    const { flags } = await api.flags.list(scope);
    const ruleset = await api.flags.ruleset({ ...scope, environmentId: environment.id });
    const { changesets } = await api.flags.history({ ...scope, environmentId: environment.id });
    const audit = await t.db.select({ action: auditLog.action }).from(auditLog);

    expect(changeset.appliedVersion).toBe(2);
    expect(flags[0]?.configs).toEqual([expect.objectContaining({ environmentId: environment.id, enabled: true })]);
    expect(ruleset).toMatchObject({ version: 2, document: { flags: { 'new-checkout': { state: 'ENABLED' } } } });
    expect(changesets).toHaveLength(2);
    expect(audit.map(row => row.action)).toEqual(
      expect.arrayContaining([
        AuditActions.flagEnvironmentCreated,
        AuditActions.flagCreated,
        AuditActions.flagChangesetApplied,
      ]),
    );
  });

  it('maps a stale base to CONFLICT, a bad op to BAD_REQUEST and a taken key to CONFLICT', async () => {
    const { api, scope } = await setup();
    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.flags });
    const { environment } = await api.flags.createEnvironment({ ...scope, key: 'staging', name: 'Staging' });
    await api.flags.createBoolean({ ...scope, key: 'a' });
    const change = { ...scope, environmentId: environment.id };

    await expect(
      api.flags.applyChangeset({
        ...change,
        baseVersion: 0,
        ops: [{ op: 'set_enabled', flagKey: 'a', enabled: true }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.flags.applyChangeset({
        ...change,
        baseVersion: 1,
        ops: [{ op: 'set_enabled', flagKey: 'b', enabled: true }],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.flags.createBoolean({ ...scope, key: 'a' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it("never reaches another workspace's environment", async () => {
    const owner = await setup();
    await owner.api.product.enable({ workspaceId: owner.scope.workspaceId, product: Products.flags });
    const { environment } = await owner.api.flags.createEnvironment({ ...owner.scope, key: 'prod', name: 'Prod' });
    const attacker = await setup('attacker@example.com');
    await attacker.api.product.enable({ workspaceId: attacker.scope.workspaceId, product: Products.flags });

    await expect(
      attacker.api.flags.ruleset({ ...attacker.scope, environmentId: environment.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(attacker.api.flags.ruleset({ ...owner.scope, environmentId: environment.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
