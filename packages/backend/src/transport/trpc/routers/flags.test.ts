import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ExecutorIds } from '@mocco/common/execution';
import { Products } from '@mocco/common/project';
import { WorkspaceMemberRoles } from '@mocco/common/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { AuthService } from '@backend/domain/auth/AuthService';
import { createTestProvider } from '@backend/domain/auth/testing/provider';
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
import { auditLog, members } from '@backend/infra/db/schema';
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
    const provider = createTestProvider(t.db);
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

  it('creates typed flags, checks variant types, and previews unsaved rules', async () => {
    const { api, scope } = await setup();
    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.flags });
    const { environment } = await api.flags.createEnvironment({ ...scope, key: 'production', name: 'Production' });
    const flag = {
      key: 'max-items',
      type: 'number' as const,
      variants: { small: 10, large: 100 },
      defaultVariant: 'small',
      offVariant: 'small',
    };

    await expect(
      api.flags.create({ ...scope, flag: { ...flag, variants: { small: 10, large: 'many' } } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await api.flags.create({ ...scope, flag });
    const { results } = await api.flags.preview({
      ...scope,
      environmentId: environment.id,
      context: { targetingKey: 'u1', plan: 'pro' },
      ops: [
        { op: 'set_enabled', flagKey: 'max-items', enabled: true },
        {
          op: 'set_rules',
          flagKey: 'max-items',
          rules: [{ clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }], serve: { variant: 'large' } }],
        },
      ],
    });
    const { segments } = await api.flags.segments({ ...scope, environmentId: environment.id });

    expect(results).toEqual([
      { flagKey: 'max-items', value: 100, variant: 'large', reason: 'TARGETING_MATCH', errorCode: null },
    ]);
    expect(segments).toEqual([]);
    await expect(
      api.flags.applyChangeset({
        ...scope,
        environmentId: environment.id,
        baseVersion: 1,
        ops: [
          {
            op: 'set_rules',
            flagKey: 'max-items',
            rules: [{ clauses: [{ attribute: 'seats', op: 'gt', values: ['ten'] }], serve: { variant: 'large' } }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it("proposes changes to a protected environment and applies them on another member's approval", async () => {
    const owner = await setup();
    const { api, scope } = owner;
    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.flags });
    const { environment } = await api.flags.createEnvironment({ ...scope, key: 'production', name: 'Production' });
    await api.flags.createBoolean({ ...scope, key: 'checkout' });
    const member = await signedInCaller('member@example.com');
    await t.db
      .insert(members)
      .values({ organizationId: scope.workspaceId, userId: member.userId, role: WorkspaceMemberRoles.member });
    const { role } = await api.role.create({ workspaceId: scope.workspaceId, name: 'release' });
    await api.role.addMember({ workspaceId: scope.workspaceId, roleId: role.id, userId: member.userId });
    const gate = { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false };

    await expect(api.flags.setChangeGate({ ...scope, environmentId: environment.id, gate })).resolves.toMatchObject({
      outcome: 'applied',
    });
    const proposed = await api.flags.applyChangeset({
      ...scope,
      environmentId: environment.id,
      baseVersion: 1,
      ops: [{ op: 'set_enabled', flagKey: 'checkout', enabled: true }],
      reason: 'launch',
    });
    const vote = { ...scope, changesetId: proposed.changeset.id, decision: 'approve' as const };

    expect(proposed).toMatchObject({
      outcome: 'pending_approval',
      changeset: { state: 'pending', requirements: gate },
    });
    await expect(member.api.flags.voteChangeset({ ...vote, contentHash: 'stale' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const { changeset } = await member.api.flags.voteChangeset({
      ...vote,
      contentHash: proposed.changeset.contentHash,
    });
    const detail = await api.flags.changeset({ ...scope, changesetId: changeset.id });

    expect(changeset).toMatchObject({ state: 'applied', appliedVersion: 2 });
    expect(detail.votes).toEqual([expect.objectContaining({ userId: member.userId, decision: 'approve' })]);
    await expect(
      api.flags.setChangeGate({ ...scope, environmentId: environment.id, gate: null }),
    ).resolves.toMatchObject({
      outcome: 'pending_approval',
    });
  });

  it('kills a flag at once, and lets only admins choose who may kill', async () => {
    const { api, scope } = await setup();
    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.flags });
    const { environment } = await api.flags.createEnvironment({ ...scope, key: 'production', name: 'Production' });
    await api.flags.createBoolean({ ...scope, key: 'checkout' });
    const member = await signedInCaller('member@example.com');
    await t.db
      .insert(members)
      .values({ organizationId: scope.workspaceId, userId: member.userId, role: WorkspaceMemberRoles.member });
    const target = { ...scope, environmentId: environment.id };

    await expect(member.api.flags.setKillRoles({ ...target, roles: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await api.flags.setKillRoles({ ...target, roles: ['oncall'] });
    await expect(member.api.flags.kill({ ...target, flagKey: 'checkout', reason: 'errors' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await api.flags.setKillRoles({ ...target, roles: [] });
    const killed = await member.api.flags.kill({ ...target, flagKey: 'checkout', reason: 'errors' });
    const { flags } = await api.flags.list(scope);

    expect(killed).toMatchObject({ changeset: { source: 'kill', state: 'applied' }, reviewRequestId: null });
    expect(flags[0]?.configs[0]).toMatchObject({ killed: true });
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

  it('lists usage and stale findings, and dismisses one until a date', async () => {
    const { api, ctx, scope } = await setup();
    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.flags });
    const { environment } = await api.flags.createEnvironment({ ...scope, key: 'production', name: 'Production' });
    await api.flags.createBoolean({ ...scope, key: 'new-checkout' });
    await ctx.flagTelemetry.ingest(
      { workspaceId: scope.workspaceId, environmentId: environment.id, keyKind: 'secret' },
      { evaluations: [{ flag: 'new-checkout', variant: 'off', count: 9, windowStart: new Date().toISOString() }] },
    );
    await ctx.staleFlags.detectAll(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000));

    const { usage } = await api.flags.usage(scope);
    const { findings } = await api.flags.stale(scope);
    expect(usage).toEqual([{ flagKey: 'new-checkout', evaluations: 9, lastSeenAt: expect.any(Date) }]);
    expect(findings).toEqual([expect.objectContaining({ flagKey: 'new-checkout', kind: 'unused' })]);

    await api.flags.dismissStale({ ...scope, findingId: findings[0]?.id ?? '', until: new Date(Date.now() + 60_000) });
    const active = await api.flags.stale(scope);
    const all = await api.flags.stale({ ...scope, includeDismissed: true });
    expect(active.findings).toEqual([]);
    expect(all.findings).toHaveLength(1);
    await expect(api.flags.dismissStale({ ...scope, findingId: randomUUID(), until: null })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
