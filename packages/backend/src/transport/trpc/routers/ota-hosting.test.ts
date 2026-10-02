import { ExecutorIds } from '@mocco/common/execution';
import { ApprovalDecisions, ApprovalStates } from '@mocco/common/governance';
import { ChannelPolicyOutcomes } from '@mocco/common/ota-hosting';
import { AppPlatforms, Products } from '@mocco/common/project';
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
import { TEST_SIGNING_CERT_PEM } from '@backend/domain/ota/testing/signing-fixtures';
import { auditLog, members, otaChannels } from '@backend/infra/db/schema';
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

describe('ota.hosting router on pglite', () => {
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
        /* OTA hosting tests don't exercise the run loop */
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

  const policy = { resume: [{ role: 'mobile-release', count: 1 }], prevent_self: true, reason_required: false };

  const setup = async () => {
    const owner = await signedInCaller('owner@example.com');
    const { workspace: ws } = await owner.api.workspace.create({ name: 'W' });
    const workspaceId = ws.id;
    await owner.api.product.enable({ workspaceId, product: Products.ota });
    const { project } = await owner.api.project.create({ workspaceId, name: 'Acme', handle: 'acme' });
    const { app: rnApp } = await owner.api.project.addApp({
      workspaceId,
      projectId: project.id,
      platform: AppPlatforms.reactNative,
      name: 'Acme RN',
    });
    const member = await signedInCaller('member@example.com');
    await t.db
      .insert(members)
      .values({ organizationId: workspaceId, userId: member.userId, role: WorkspaceMemberRoles.member });
    const { role } = await owner.api.role.create({ workspaceId, name: 'mobile-release' });
    await owner.api.role.addMember({ workspaceId, roleId: role.id, userId: member.userId });
    return { owner, member, workspaceId, projectId: project.id, rnAppId: rnApp.id };
  };

  it('hosts a React Native app with fixed device-facing URLs, and refuses other platforms', async () => {
    const { owner, workspaceId, projectId, rnAppId } = await setup();
    const { app: iosApp } = await owner.api.project.addApp({
      workspaceId,
      projectId,
      platform: AppPlatforms.ios,
      name: 'Acme iOS',
    });

    const { app } = await owner.api.ota.hosting.apps.create({ workspaceId, projectId, projectAppId: rnAppId });

    expect(app.manifestUrl).toBe(`https://mocco.test/api/ext/v1/ota/apps/${app.id}/manifest`);
    expect(app.assetBaseUrl).toBe(`https://mocco.test/api/ext/v1/ota/apps/${app.id}/assets`);
    expect(app.signingRequired).toBe(true);
    await expect(
      owner.api.ota.hosting.apps.create({ workspaceId, projectId, projectAppId: rnAppId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      owner.api.ota.hosting.apps.create({ workspaceId, projectId, projectAppId: iosApp.id }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const audit = await t.db.select().from(auditLog);
    expect(audit.map(entry => entry.action)).toContain('ota.app.created');
  });

  it('lets owners and admins register a certificate, and refuses members and bad PEMs', async () => {
    const { owner, member, workspaceId, projectId, rnAppId } = await setup();
    const { app } = await owner.api.ota.hosting.apps.create({ workspaceId, projectId, projectAppId: rnAppId });
    const appInput = { workspaceId, projectId, appId: app.id };

    const { certificate } = await owner.api.ota.hosting.certificates.add({
      ...appInput,
      certificatePem: TEST_SIGNING_CERT_PEM,
    });

    expect(certificate).toMatchObject({ keyid: 'root', status: 'active' });
    await expect(
      member.api.ota.hosting.certificates.add({ ...appInput, certificatePem: TEST_SIGNING_CERT_PEM }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      owner.api.ota.hosting.certificates.add({ ...appInput, certificatePem: TEST_SIGNING_CERT_PEM }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      owner.api.ota.hosting.certificates.add({ ...appInput, certificatePem: 'not a pem' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const listed = await member.api.ota.hosting.certificates.list(appInput);
    expect(listed.certificates).toHaveLength(1);

    await owner.api.ota.hosting.certificates.retire({ ...appInput, certificateId: certificate.id });
    const after = await owner.api.ota.hosting.certificates.list(appInput);
    expect(after.certificates[0]?.status).toBe('retired');
  });

  it('protects a channel at once, but changes an existing protection only through an approval', async () => {
    const { owner, member, workspaceId, projectId, rnAppId } = await setup();
    const { app } = await owner.api.ota.hosting.apps.create({ workspaceId, projectId, projectAppId: rnAppId });
    const appInput = { workspaceId, projectId, appId: app.id };
    const { channel } = await owner.api.ota.hosting.channels.create({ ...appInput, name: 'production' });
    expect(channel.isProtected).toBe(false);

    const protect = await owner.api.ota.hosting.channels.changePolicy({ ...appInput, channelId: channel.id, policy });
    expect(protect).toMatchObject({ outcome: ChannelPolicyOutcomes.applied, channel: { isProtected: true, policy } });

    const removal = await owner.api.ota.hosting.channels.changePolicy({
      ...appInput,
      channelId: channel.id,
      policy: null,
    });
    expect(removal.outcome).toBe(ChannelPolicyOutcomes.pendingApproval);
    const still = await owner.api.ota.hosting.channels.list(appInput);
    expect(still.channels[0]?.isProtected).toBe(true);

    const decided = await member.api.approval.vote({
      workspaceId,
      requestId: removal.requestId ?? '',
      decision: ApprovalDecisions.approve,
    });
    expect(decided.request.state).toBe(ApprovalStates.approved);
    const after = await owner.api.ota.hosting.channels.list(appInput);
    expect(after.channels[0]).toMatchObject({ isProtected: false, policy: null });
    const audit = await t.db.select().from(auditLog);
    const actions = audit.map(entry => entry.action);
    expect(actions.filter(action => action === 'ota.channel.policy_changed')).toHaveLength(2);
  });

  it('refuses a protected channel without a policy at the database', async () => {
    const { owner, workspaceId, projectId, rnAppId } = await setup();
    const { app } = await owner.api.ota.hosting.apps.create({ workspaceId, projectId, projectAppId: rnAppId });
    await expect(
      t.db.insert(otaChannels).values({ workspaceId, appId: app.id, name: 'broken', isProtected: true, policy: null }),
    ).rejects.toThrow();
  });

  it('requires the OTA product', async () => {
    const { owner, workspaceId, projectId } = await setup();
    await owner.api.product.disable({ workspaceId, product: Products.ota });
    await expect(owner.api.ota.hosting.apps.list({ workspaceId, projectId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
