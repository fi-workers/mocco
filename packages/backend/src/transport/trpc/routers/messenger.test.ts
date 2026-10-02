import { createHmac } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ExecutorIds } from '@mocco/common/execution';
import { Products } from '@mocco/common/project';
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

describe('messenger router on pglite', () => {
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
        /* messenger tests don't exercise the run loop */
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

  it('requires the messenger product, and shows the identity secret only when set up or rotated', async () => {
    const { api, scope } = await setup();
    await expect(api.messenger.settings(scope)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.messenger });

    expect(await api.messenger.settings(scope)).toEqual({ settings: null });
    const { identitySecret } = await api.messenger.enable(scope);
    await expect(api.messenger.enable(scope)).rejects.toMatchObject({ code: 'CONFLICT' });
    const { settings } = await api.messenger.settings(scope);
    const rotated = await api.messenger.rotateSecret(scope);

    expect(identitySecret).toMatch(/^[0-9a-f]{64}$/u);
    expect(rotated.identitySecret).not.toBe(identitySecret);
    expect(JSON.stringify(settings)).not.toContain(identitySecret);
    expect(settings?.categories.map(category => category.key)).toEqual(['bug', 'billing', 'how-to', 'idea', 'other']);
    const audit = await t.db.select({ action: auditLog.action }).from(auditLog);
    expect(audit.map(row => row.action)).toEqual(
      expect.arrayContaining([AuditActions.messengerEnabled, AuditActions.messengerSecretRotated]),
    );
  });

  it('lists the inbox with unread state, replies, notes and closes', async () => {
    const { api, ctx, scope, userId } = await setup();
    await api.product.enable({ workspaceId: scope.workspaceId, product: Products.messenger });
    const { identitySecret } = await api.messenger.enable(scope);
    const session = await ctx.contactMessenger.createSession(scope, {
      userId: 'minji',
      userHash: createHmac('sha256', identitySecret).update('minji').digest('hex'),
      name: 'Minji',
    });
    const principal = await ctx.contactMessenger.authenticate(session.sessionToken);
    if (principal === undefined) {
      throw new Error('no session');
    }
    const started = await ctx.contactMessenger.startConversation(principal, {
      category: 'billing',
      body: 'I was charged twice',
      clientMessageId: 'client-message-1',
    });

    const { conversations } = await api.messenger.inbox(scope);
    expect(conversations).toEqual([
      expect.objectContaining({
        id: started.id,
        category: 'billing',
        isUnread: true,
        contact: expect.objectContaining({ name: 'Minji', externalUserId: 'minji' }),
      }),
    ]);
    await api.messenger.write({ ...scope, conversationId: started.id, body: 'Refund issued', internal: false });
    await api.messenger.write({ ...scope, conversationId: started.id, body: 'Checked Stripe', internal: true });
    const after = await api.messenger.inbox(scope);
    const detail = await api.messenger.conversation({ ...scope, conversationId: started.id });
    await api.messenger.setStatus({ ...scope, conversationId: started.id, status: 'closed' });

    expect(after.conversations[0]?.isUnread).toBe(false);
    expect(detail.messages.map(message => [message.seq, message.visibility, message.authorUserId])).toEqual([
      [1, 'public', null],
      [2, 'public', userId],
      [3, 'internal', userId],
    ]);
    const open = await api.messenger.inbox(scope);
    const closed = await api.messenger.inbox({ ...scope, status: 'closed' });
    expect(open.conversations).toEqual([]);
    expect(closed.conversations).toHaveLength(1);
  });

  it("never reaches another workspace's conversations", async () => {
    const owner = await setup();
    await owner.api.product.enable({ workspaceId: owner.scope.workspaceId, product: Products.messenger });
    const { identitySecret } = await owner.api.messenger.enable(owner.scope);
    const session = await owner.ctx.contactMessenger.createSession(owner.scope, {
      userId: 'u1',
      userHash: createHmac('sha256', identitySecret).update('u1').digest('hex'),
    });
    const principal = await owner.ctx.contactMessenger.authenticate(session.sessionToken);
    if (principal === undefined) {
      throw new Error('no session');
    }
    const started = await owner.ctx.contactMessenger.startConversation(principal, {
      body: 'hello',
      clientMessageId: 'client-message-2',
    });
    const attacker = await setup('attacker@example.com');
    await attacker.api.product.enable({ workspaceId: attacker.scope.workspaceId, product: Products.messenger });

    await expect(
      attacker.api.messenger.conversation({ ...attacker.scope, conversationId: started.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      attacker.api.messenger.write({ ...attacker.scope, conversationId: started.id, body: 'x', internal: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      attacker.api.messenger.conversation({ ...owner.scope, conversationId: started.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
