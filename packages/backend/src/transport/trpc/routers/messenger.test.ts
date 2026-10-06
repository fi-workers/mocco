import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AuditActions } from '@mocco/common/audit';
import { ExecutorIds } from '@mocco/common/execution';
import { Products } from '@mocco/common/project';
import { eq } from 'drizzle-orm';
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
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { auditLog, messengerAttachments, objects } from '@backend/infra/db/schema';
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
  let root: string;
  let store: FilesystemObjectStore;
  let storage: StorageService;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = await createTestProvider(t.db);
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
    root = await mkdtemp(path.join(tmpdir(), 'mocco-messenger-router-'));
    store = new FilesystemObjectStore({
      root,
      baseUrl: 'https://storage.test/api/ext/internal/storage',
      signer: new StorageUrlSigner('router-signing-key'),
    });
    storage = new StorageService({ objects: new ObjectRepo(t.db), store });
  });
  afterEach(async () => {
    await t.close();
    await rm(root, { recursive: true, force: true });
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
    const box = new SecretBox([{ id: 'test', key: randomBytes(32) }]);
    const ctx = {
      ...contextServices(t.db),
      // The messenger with object storage, so attachments work.
      ...createMessengerDomain(t.db, {
        audit: makeAudit(),
        box: () => box,
        storage,
      }),
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

  it('manages the round-robin rotation, and keeps it to the workspace', async () => {
    const owner = await setup();
    await owner.api.product.enable({ workspaceId: owner.scope.workspaceId, product: Products.messenger });
    await owner.api.messenger.enable(owner.scope);
    await owner.api.messenger.addInboxMember({ ...owner.scope, userId: owner.userId });
    await owner.api.messenger.setAvailability({ ...owner.scope, userId: owner.userId, available: false });

    expect(await owner.api.messenger.inboxMembers(owner.scope)).toEqual({
      members: [expect.objectContaining({ userId: owner.userId, available: false, lastAssignedAt: null })],
    });
    const attacker = await setup('attacker@example.com');
    await attacker.api.product.enable({ workspaceId: attacker.scope.workspaceId, product: Products.messenger });
    await attacker.api.messenger.enable(attacker.scope);
    // Someone from another workspace can't join, read or change this rotation.
    await expect(owner.api.messenger.addInboxMember({ ...owner.scope, userId: attacker.userId })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );
    await expect(attacker.api.messenger.inboxMembers(owner.scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      attacker.api.messenger.setAvailability({ ...attacker.scope, userId: owner.userId, available: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await owner.api.messenger.removeInboxMember({ ...owner.scope, userId: owner.userId });
    expect(await owner.api.messenger.inboxMembers(owner.scope)).toEqual({ members: [] });
  });

  it('assigns a conversation by hand to a workspace member or to no one, audited, and nowhere else', async () => {
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
      clientMessageId: 'client-message-4',
    });
    const conversation = { ...owner.scope, conversationId: started.id };
    const attacker = await setup('attacker@example.com');
    await attacker.api.product.enable({ workspaceId: attacker.scope.workspaceId, product: Products.messenger });

    expect(await owner.api.messenger.assign({ ...conversation, assigneeUserId: owner.userId })).toEqual({
      conversationId: started.id,
      assignee: { userId: owner.userId, name: 'fixture-user' },
      changed: true,
    });
    const assigned = await owner.api.messenger.conversation(conversation);
    expect(assigned.assignee).toMatchObject({ userId: owner.userId });
    // Again changes nothing, and records nothing.
    expect(await owner.api.messenger.assign({ ...conversation, assigneeUserId: owner.userId })).toMatchObject({
      changed: false,
    });
    await expect(
      owner.api.messenger.assign({ ...conversation, assigneeUserId: attacker.userId }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      attacker.api.messenger.assign({ ...attacker.scope, conversationId: started.id, assigneeUserId: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await owner.api.messenger.assign({ ...conversation, assigneeUserId: null });

    const unassigned = await owner.api.messenger.conversation(conversation);
    expect(unassigned.assignee).toBeNull();
    const audit = await t.db
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.action, AuditActions.messengerConversationAssigned));
    expect(audit.map(row => row.payload)).toEqual([
      { projectId: owner.scope.projectId, from: null, to: owner.userId },
      { projectId: owner.scope.projectId, from: owner.userId, to: null },
    ]);
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

  it("attaches the caller's own uploads to a reply, and nothing from another workspace", async () => {
    const owner = await setup();
    await owner.api.product.enable({ workspaceId: owner.scope.workspaceId, product: Products.messenger });
    const { identitySecret } = await owner.api.messenger.enable(owner.scope);
    const session = await owner.ctx.contactMessenger.createSession(owner.scope, {
      userId: 'minji',
      userHash: createHmac('sha256', identitySecret).update('minji').digest('hex'),
    });
    const principal = await owner.ctx.contactMessenger.authenticate(session.sessionToken);
    if (principal === undefined) {
      throw new Error('no session');
    }
    const started = await owner.ctx.contactMessenger.startConversation(principal, {
      body: 'Where is my receipt?',
      clientMessageId: 'client-message-3',
    });
    const conversation = { ...owner.scope, conversationId: started.id };
    const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
    const reserved = await owner.api.messenger.createAttachment({
      ...conversation,
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
      filename: 'Receipt.pdf',
    });
    const [row] = await t.db
      .select({ key: objects.key })
      .from(messengerAttachments)
      .innerJoin(objects, eq(objects.id, messengerAttachments.objectId))
      .where(eq(messengerAttachments.id, reserved.attachmentId));
    await store.put(row?.key ?? '', pdf, { contentType: 'application/pdf', visibility: 'private' });
    const attacker = await setup('attacker@example.com');
    await attacker.api.product.enable({ workspaceId: attacker.scope.workspaceId, product: Products.messenger });

    await expect(
      owner.api.messenger.createAttachment({ ...conversation, contentType: 'image/svg+xml' as never, sizeBytes: 10 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      owner.api.messenger.write({
        ...conversation,
        body: 'x',
        attachmentIds: Array.from({ length: 4 }, () => reserved.attachmentId),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      attacker.api.messenger.createAttachment({
        ...attacker.scope,
        conversationId: started.id,
        contentType: 'image/png',
        sizeBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      attacker.api.messenger.write({ ...conversation, body: 'x', attachmentIds: [reserved.attachmentId] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await owner.api.messenger.write({ ...conversation, body: 'Attached', attachmentIds: [reserved.attachmentId] });
    const detail = await owner.api.messenger.conversation(conversation);
    expect(detail.messages[1]?.attachments).toMatchObject([
      { id: reserved.attachmentId, contentType: 'application/pdf', filename: 'receipt.pdf' },
    ]);
    // Sent once: it can't go out again.
    await expect(
      owner.api.messenger.write({ ...conversation, body: 'Again', attachmentIds: [reserved.attachmentId] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
