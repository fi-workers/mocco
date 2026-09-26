import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { InboundKinds, InboundOutcomes, InboundSourceStatuses } from '@mocco/common/inbound';
import { WorkspaceMemberRoles, type WorkspaceMemberRole } from '@mocco/common/workspace';
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
import { createInboundHarness, ingestKeyOf, signedDelivery } from '@backend/domain/inbound/testing/harness';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { members } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';
import { contextServices } from '@backend/transport/trpc/testing/context-services';

import type { InboundDomain } from '@backend/domain/inbound/instance';

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

describe('inbound router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;
  let inbound: InboundDomain;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
    inbound = createInboundHarness(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  const makeAudit = (): AuditService => new AuditService({ audit: new AuditRepo(t.db) });

  const signedInCaller = async (email: string, options: { inbound?: InboundDomain | null } = {}) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = new RunService({
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
        /* inbound router tests don't exercise the run loop */
      },
    });
    const api = appRouter.createCaller({
      ...contextServices(t.db),
      auth,
      workspace,
      runs,
      roles: new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) }),
      gates: new GateService({
        bus: createTestEventBus(t.db),
        runs: new RunRepo(t.db),
        runGates: new RunGateRepo(t.db),
        resumes: new ResumeRepo(t.db),
        memberships: new RoleMembershipRepo(t.db),
        events: new RunEventRepo(t.db),
        resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
        audit: makeAudit(),
      }),
      grants: new GrantService({ grants: new CredentialGrantRepo(t.db) }),
      audit: makeAudit(),
      inbound: options.inbound === null ? undefined : (options.inbound ?? inbound),
      session,
      headers,
    });
    return { api, userId: session?.user.id ?? '' };
  };

  /** An owner with a workspace, plus a second user joined to it with `role`. */
  const ownerAndMember = async (role: WorkspaceMemberRole) => {
    const owner = await signedInCaller(`owner-${randomUUID()}@example.com`);
    const { workspace: ws } = await owner.api.workspace.create({ name: 'W' });
    const other = await signedInCaller(`${role}-${randomUUID()}@example.com`);
    await t.db.insert(members).values({ organizationId: ws.id, userId: other.userId, role });
    return { owner, other, workspaceId: ws.id };
  };

  describe('sources', () => {
    it('creates a GitHub source and returns its generated secret once; list never shows it', async () => {
      const { api } = await signedInCaller('create@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });

      const created = await api.inbound.sources.create({ workspaceId: ws.id, kind: InboundKinds.github, name: 'repo' });

      expect(created.generatedSecret).toMatch(/^[\da-f]{64}$/u);
      expect(created.source).toMatchObject({ kind: InboundKinds.github, name: 'repo', hasSecret: true });
      expect(Object.keys(created.source)).not.toContain('secretSealed');
      expect(Object.keys(created.source)).not.toContain('workspaceId');
      const { sources } = await api.inbound.sources.list({ workspaceId: ws.id });
      expect(sources).toEqual([created.source]);
      expect(JSON.stringify(sources)).not.toContain(created.generatedSecret ?? '-');
    });

    it('creates a Sentry source from a pasted secret and never echoes it', async () => {
      const { api } = await signedInCaller('sentry@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });

      const created = await api.inbound.sources.create({
        workspaceId: ws.id,
        kind: InboundKinds.sentry,
        name: 'web',
        secret: 'pasted-sentry-secret',
      });

      expect(created.generatedSecret).toBeNull();
      expect(JSON.stringify(created)).not.toContain('pasted-sentry-secret');
      const rotated = await api.inbound.sources.rotateSecret({
        workspaceId: ws.id,
        sourceId: created.source.id,
        secret: 'rotated-sentry-secret',
      });
      expect(JSON.stringify(rotated)).not.toContain('rotated-sentry-secret');
    });

    it('rejects a Sentry source without a secret as BAD_REQUEST', async () => {
      const { api } = await signedInCaller('nosecret@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });

      await expect(
        api.inbound.sources.create({ workspaceId: ws.id, kind: InboundKinds.vercel, name: 'x' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('renames, pauses, resumes, rotates and deletes', async () => {
      const { api } = await signedInCaller('lifecycle@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const { source } = await api.inbound.sources.create({ workspaceId: ws.id, kind: InboundKinds.github, name: 'a' });
      const scope = { workspaceId: ws.id, sourceId: source.id };

      const renamed = await api.inbound.sources.rename({ ...scope, name: 'b' });
      expect(renamed.source.name).toBe('b');
      const paused = await api.inbound.sources.pause(scope);
      expect(paused.source.status).toBe(InboundSourceStatuses.paused);
      const resumed = await api.inbound.sources.resume(scope);
      expect(resumed.source.status).toBe(InboundSourceStatuses.active);
      const rotated = await api.inbound.sources.rotateSecret(scope);
      expect(rotated.generatedSecret).toMatch(/^[\da-f]{64}$/u);
      expect(rotated.source.ingestUrl).toBe(source.ingestUrl);
      expect(await api.inbound.sources.delete(scope)).toEqual({ ok: true });
      expect(await api.inbound.sources.list({ workspaceId: ws.id })).toEqual({ sources: [] });
      await expect(api.inbound.sources.delete(scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('is PRECONDITION_FAILED when inbound is not configured', async () => {
      const { api } = await signedInCaller('unconfigured@example.com', { inbound: null });
      const { workspace: ws } = await api.workspace.create({ name: 'W' });

      await expect(api.inbound.sources.list({ workspaceId: ws.id })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });
  });

  describe('roles', () => {
    it('lets a plain member read but not write (FORBIDDEN)', async () => {
      const { owner, other, workspaceId } = await ownerAndMember(WorkspaceMemberRoles.member);
      const { source } = await owner.api.inbound.sources.create({ workspaceId, kind: InboundKinds.github, name: 'a' });
      const scope = { workspaceId, sourceId: source.id };

      const listed = await other.api.inbound.sources.list({ workspaceId });
      expect(listed.sources).toHaveLength(1);
      expect(await other.api.inbound.receipts.list({ workspaceId })).toEqual({ receipts: [], nextCursor: null });
      const forbidden = { code: 'FORBIDDEN' };
      await expect(
        other.api.inbound.sources.create({ workspaceId, kind: InboundKinds.github, name: 'b' }),
      ).rejects.toMatchObject(forbidden);
      await expect(other.api.inbound.sources.rename({ ...scope, name: 'x' })).rejects.toMatchObject(forbidden);
      await expect(other.api.inbound.sources.pause(scope)).rejects.toMatchObject(forbidden);
      await expect(other.api.inbound.sources.resume(scope)).rejects.toMatchObject(forbidden);
      await expect(other.api.inbound.sources.rotateSecret(scope)).rejects.toMatchObject(forbidden);
      await expect(other.api.inbound.sources.delete(scope)).rejects.toMatchObject(forbidden);
    });

    it('lets an admin write', async () => {
      const { other, workspaceId } = await ownerAndMember(WorkspaceMemberRoles.admin);

      const created = await other.api.inbound.sources.create({ workspaceId, kind: InboundKinds.github, name: 'a' });

      expect(created.source.name).toBe('a');
    });
  });

  describe('tenant isolation', () => {
    it('a non-member gets NOT_FOUND on every procedure', async () => {
      const owner = await signedInCaller('owner-a@example.com');
      const { workspace: wsA } = await owner.api.workspace.create({ name: 'A' });
      const { source } = await owner.api.inbound.sources.create({
        workspaceId: wsA.id,
        kind: InboundKinds.github,
        name: 'a',
      });
      const stranger = await signedInCaller('stranger@example.com');
      const scope = { workspaceId: wsA.id, sourceId: source.id };
      const notFound = { code: 'NOT_FOUND' };

      await expect(stranger.api.inbound.sources.list({ workspaceId: wsA.id })).rejects.toMatchObject(notFound);
      await expect(
        stranger.api.inbound.sources.create({ workspaceId: wsA.id, kind: InboundKinds.github, name: 'x' }),
      ).rejects.toMatchObject(notFound);
      await expect(stranger.api.inbound.sources.rename({ ...scope, name: 'x' })).rejects.toMatchObject(notFound);
      await expect(stranger.api.inbound.sources.pause(scope)).rejects.toMatchObject(notFound);
      await expect(stranger.api.inbound.sources.resume(scope)).rejects.toMatchObject(notFound);
      await expect(stranger.api.inbound.sources.rotateSecret(scope)).rejects.toMatchObject(notFound);
      await expect(stranger.api.inbound.sources.delete(scope)).rejects.toMatchObject(notFound);
      await expect(stranger.api.inbound.receipts.list({ workspaceId: wsA.id })).rejects.toMatchObject(notFound);
    });

    it("A's source id used in B's own workspace is NOT_FOUND", async () => {
      const ownerA = await signedInCaller('a@example.com');
      const { workspace: wsA } = await ownerA.api.workspace.create({ name: 'A' });
      const { source } = await ownerA.api.inbound.sources.create({
        workspaceId: wsA.id,
        kind: InboundKinds.github,
        name: 'a',
      });
      const ownerB = await signedInCaller('b@example.com');
      const { workspace: wsB } = await ownerB.api.workspace.create({ name: 'B' });

      await expect(
        ownerB.api.inbound.sources.pause({ workspaceId: wsB.id, sourceId: source.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        ownerB.api.inbound.sources.rotateSecret({ workspaceId: wsB.id, sourceId: source.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await ownerB.api.inbound.receipts.list({ workspaceId: wsB.id, sourceId: source.id })).toEqual({
        receipts: [],
        nextCursor: null,
      });
    });
  });

  describe('receipts', () => {
    it.each(['9223372036854775808', '99999999999999999999', '-1', '1.5'])(
      'rejects the cursor %j as BAD_REQUEST',
      async beforeSeq => {
        const { api } = await signedInCaller(`cursor-${randomUUID()}@example.com`);
        const { workspace: ws } = await api.workspace.create({ name: 'W' });

        await expect(api.inbound.receipts.list({ workspaceId: ws.id, beforeSeq })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
      },
    );

    it('accepts the largest bigint cursor', async () => {
      const { api } = await signedInCaller('max-cursor@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });

      expect(await api.inbound.receipts.list({ workspaceId: ws.id, beforeSeq: '9223372036854775807' })).toEqual({
        receipts: [],
        nextCursor: null,
      });
    });

    it('lists receipts newest first, filters by source and outcome, and pages by seq', async () => {
      const { api } = await signedInCaller('receipts@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const { source, generatedSecret } = await api.inbound.sources.create({
        workspaceId: ws.id,
        kind: InboundKinds.github,
        name: 'a',
      });
      const ingestKey = ingestKeyOf(source.ingestUrl);
      const secret = generatedSecret ?? '';
      // Deliveries arrive one after another.
      await ['d1', 'd2', 'd3'].reduce(async (previous, deliveryId) => {
        await previous;
        await inbound.inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.github, secret, { deliveryId }) });
      }, Promise.resolve());
      const ping = signedDelivery(InboundKinds.github, secret, { deliveryId: 'p1' });
      ping.headers.set('x-github-event', 'ping');
      await inbound.inbound.ingest({ ingestKey, ...ping });

      const first = await api.inbound.receipts.list({ workspaceId: ws.id, limit: 2 });
      expect(first.receipts.map(receipt => receipt.externalId)).toEqual(['p1', 'd3']);
      expect(first.nextCursor).toBe(first.receipts[1]?.seq);
      const second = await api.inbound.receipts.list({
        workspaceId: ws.id,
        limit: 2,
        beforeSeq: first.nextCursor ?? undefined,
      });
      expect(second.receipts.map(receipt => receipt.externalId)).toEqual(['d2', 'd1']);
      const ignored = await api.inbound.receipts.list({
        workspaceId: ws.id,
        sourceId: source.id,
        outcome: InboundOutcomes.ignored,
      });
      expect(ignored.receipts).toMatchObject([{ externalId: 'p1', reason: 'ping', eventType: null }]);
      expect(ignored.nextCursor).toBeNull();
      expect(Object.keys(first.receipts[0] ?? {})).not.toContain('normalized');
    });
  });
});
