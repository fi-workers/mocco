import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { Products } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
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
import { createApprovalService } from '@backend/domain/governance/instance';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { appRouter } from '@backend/transport/trpc/root';
import { router } from '@backend/transport/trpc/trpc';

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

describe('project + product routers on pglite', () => {
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
        /* project router tests don't exercise the run loop */
      },
    });

  type Api = ReturnType<typeof appRouter.createCaller>;

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
      audit: makeAudit(),
    });
    const grants = new GrantService({ grants: new CredentialGrantRepo(t.db) });
    const ctx = {
      ...createProjectDomain(t.db),
      approvals: createApprovalService(t.db, new AuditService({ audit: new AuditRepo(t.db) })),
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

  const newProject = async (api: Api, workspaceId: string, handle = 'acme') => {
    const { project } = await api.project.create({ workspaceId, name: 'Acme', handle });
    return project;
  };

  const listProducts = async (api: Api, workspaceId: string) => {
    const { products } = await api.product.list({ workspaceId });
    return products;
  };

  describe('project', () => {
    it('creates, gets, lists, updates and archives a project', async () => {
      const { api } = await signedInCaller('create@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });

      const project = await newProject(api, ws.id);
      expect(project).toMatchObject({ workspaceId: ws.id, handle: 'acme', archivedAt: null });
      const { project: fetched } = await api.project.get({ workspaceId: ws.id, projectId: project.id });
      expect(fetched.id).toBe(project.id);

      const updated = await api.project.update({ workspaceId: ws.id, projectId: project.id, name: 'Acme app' });
      expect(updated.project.name).toBe('Acme app');

      await api.project.setArchived({ workspaceId: ws.id, projectId: project.id, archived: true });
      const { projects: visible } = await api.project.list({ workspaceId: ws.id });
      expect(visible).toHaveLength(0);
      const { projects: all } = await api.project.list({ workspaceId: ws.id, includeArchived: true });
      expect(all).toHaveLength(1);
    });

    it('maps a taken handle to CONFLICT and an invalid handle to BAD_REQUEST', async () => {
      const { api } = await signedInCaller('conflict@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      await newProject(api, ws.id);

      await expect(api.project.create({ workspaceId: ws.id, name: 'Dup', handle: 'acme' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await expect(api.project.create({ workspaceId: ws.id, name: 'Bad', handle: 'Not OK' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('adds and lists apps; an archived project rejects changes as BAD_REQUEST', async () => {
      const { api } = await signedInCaller('apps@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const project = await newProject(api, ws.id);

      await api.project.addApp({
        workspaceId: ws.id,
        projectId: project.id,
        platform: 'ios',
        name: 'iOS',
        bundleId: 'com.acme',
      });
      const { apps } = await api.project.listApps({ workspaceId: ws.id, projectId: project.id });
      expect(apps).toHaveLength(1);

      await api.project.setArchived({ workspaceId: ws.id, projectId: project.id, archived: true });
      await expect(
        api.project.addApp({ workspaceId: ws.id, projectId: project.id, platform: 'web', name: 'Web' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });

  describe('tenant isolation', () => {
    it('a non-member gets NOT_FOUND on every project procedure', async () => {
      const owner = await signedInCaller('owner@example.com');
      const { workspace: ws } = await owner.api.workspace.create({ name: 'A' });
      const project = await newProject(owner.api, ws.id);
      const scope = { workspaceId: ws.id, projectId: project.id };

      const { api } = await signedInCaller('stranger@example.com');
      const calls: (() => Promise<unknown>)[] = [
        async () => await api.project.create({ workspaceId: ws.id, name: 'x', handle: 'x' }),
        async () => await api.project.list({ workspaceId: ws.id }),
        async () => await api.project.get(scope),
        async () => await api.project.update({ ...scope, name: 'x' }),
        async () => await api.project.setArchived({ ...scope, archived: true }),
        async () => await api.project.addApp({ ...scope, platform: 'web', name: 'x' }),
        async () => await api.project.listApps(scope),
        async () => await api.project.removeApp({ ...scope, appId: randomUUID() }),
        async () => await api.project.linkRepo({ ...scope, repoId: randomUUID() }),
        async () => await api.project.unlinkRepo({ ...scope, repoId: randomUUID() }),
        async () => await api.project.listRepos(scope),
        async () => await api.product.list({ workspaceId: ws.id }),
        async () => await api.product.enable({ workspaceId: ws.id, product: Products.ota }),
        async () => await api.product.disable({ workspaceId: ws.id, product: Products.ota }),
      ];
      await Promise.all(calls.map(async call => await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' })));
    });

    it("a project from another workspace is NOT_FOUND even through the caller's own workspace", async () => {
      const ownerA = await signedInCaller('owner-a@example.com');
      const { workspace: wsA } = await ownerA.api.workspace.create({ name: 'A' });
      const projectA = await newProject(ownerA.api, wsA.id);

      const ownerB = await signedInCaller('owner-b@example.com');
      const { workspace: wsB } = await ownerB.api.workspace.create({ name: 'B' });
      const foreign = { workspaceId: wsB.id, projectId: projectA.id };

      await expect(ownerB.api.project.get(foreign)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(ownerB.api.project.update({ ...foreign, name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(ownerB.api.project.listApps(foreign)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('product', () => {
    it('lists governance by default, enables and disables idempotently, and keeps governance on', async () => {
      const { api } = await signedInCaller('product@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });

      expect(await listProducts(api, ws.id)).toEqual([Products.governance]);
      await api.product.enable({ workspaceId: ws.id, product: Products.ota });
      await api.product.enable({ workspaceId: ws.id, product: Products.ota });
      expect(await listProducts(api, ws.id)).toEqual([Products.governance, Products.ota]);

      await api.product.disable({ workspaceId: ws.id, product: Products.ota });
      expect(await listProducts(api, ws.id)).toEqual([Products.governance]);
      await expect(api.product.disable({ workspaceId: ws.id, product: Products.governance })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('productProcedure is FORBIDDEN until the product is enabled, and still enforces project scope', async () => {
      const probe = router({
        ping: productProcedure(Products.ota)
          .input(z.object({ workspaceId: z.uuid(), projectId: z.uuid() }))
          .query(() => 'pong'),
      });
      const { api, ctx } = await signedInCaller('probe@example.com');
      const { workspace: ws } = await api.workspace.create({ name: 'W' });
      const project = await newProject(api, ws.id);
      const caller = probe.createCaller(ctx);

      await expect(caller.ping({ workspaceId: ws.id, projectId: project.id })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await api.product.enable({ workspaceId: ws.id, product: Products.ota });
      expect(await caller.ping({ workspaceId: ws.id, projectId: project.id })).toBe('pong');
      await expect(caller.ping({ workspaceId: ws.id, projectId: randomUUID() })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
