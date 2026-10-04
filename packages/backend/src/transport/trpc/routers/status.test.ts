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
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';
import { statusRouter } from '@backend/transport/trpc/routers/status';
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

type Api = ReturnType<typeof appRouter.createCaller>;
interface Scope {
  workspaceId: string;
  projectId: string;
}
interface Ids {
  pageId: string;
  groupId: string;
  componentId: string;
}

/** One call per status procedure: `scope` is the tenant the caller claims, `ids` the entities it targets. */
const calls: Record<string, (api: Api, scope: Scope, ids: Ids) => Promise<unknown>> = {
  pages: async (api, scope) => await api.status.pages(scope),
  page: async (api, scope, ids) => await api.status.page({ ...scope, pageId: ids.pageId }),
  createPage: async (api, scope) => await api.status.createPage({ ...scope, slug: 'attacker', title: 'x' }),
  updatePage: async (api, scope, ids) =>
    await api.status.updatePage({ ...scope, pageId: ids.pageId, slug: 'taken-over', title: 'x' }),
  deletePage: async (api, scope, ids) => await api.status.deletePage({ ...scope, pageId: ids.pageId }),
  createGroup: async (api, scope, ids) => await api.status.createGroup({ ...scope, pageId: ids.pageId, name: 'x' }),
  updateGroup: async (api, scope, ids) => await api.status.updateGroup({ ...scope, groupId: ids.groupId, name: 'x' }),
  deleteGroup: async (api, scope, ids) => await api.status.deleteGroup({ ...scope, groupId: ids.groupId }),
  createComponent: async (api, scope, ids) =>
    await api.status.createComponent({ ...scope, pageId: ids.pageId, name: 'x' }),
  updateComponent: async (api, scope, ids) =>
    await api.status.updateComponent({ ...scope, componentId: ids.componentId, name: 'x' }),
  setComponentStatus: async (api, scope, ids) =>
    await api.status.setComponentStatus({ ...scope, componentId: ids.componentId, status: 'major_outage' }),
  deleteComponent: async (api, scope, ids) =>
    await api.status.deleteComponent({ ...scope, componentId: ids.componentId }),
};

/** Procedures that take no entity id: with the caller's own scope they act on the caller's own data. */
const scopeOnly = new Set(['pages', 'createPage']);

/** The tRPC error code a call ends with, or 'ok'. */
const outcome = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

/** A page with a group and a component in it. */
const seed = async (api: Api, scope: Scope, slug: string): Promise<Ids> => {
  const { page } = await api.status.createPage({ ...scope, slug, title: 'Status' });
  const { group } = await api.status.createGroup({ ...scope, pageId: page.id, name: 'Core' });
  const { component } = await api.status.createComponent({ ...scope, pageId: page.id, name: 'API', groupId: group.id });
  return { pageId: page.id, groupId: group.id, componentId: component.id };
};

describe('status router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = await createTestProvider(t.db);
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
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
      audit,
      waitUntil: () => {
        /* status tests don't exercise the run loop */
      },
    });
    const ctx = {
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
        audit,
      }),
      grants: new GrantService({ grants: new CredentialGrantRepo(t.db) }),
      audit,
      session,
      headers,
    };
    return appRouter.createCaller(ctx);
  };

  const setup = async (email: string, handle: string) => {
    const api = await signedInCaller(email);
    const { workspace: ws } = await api.workspace.create({ name: handle });
    const { project } = await api.project.create({ workspaceId: ws.id, name: handle, handle });
    const scope = { workspaceId: ws.id, projectId: project.id };
    await api.product.enable({ workspaceId: ws.id, product: Products.status });
    return { api, scope };
  };

  it('requires the status product', async () => {
    const api = await signedInCaller('owner@example.com');
    const { workspace: ws } = await api.workspace.create({ name: 'W' });
    const { project } = await api.project.create({ workspaceId: ws.id, name: 'Acme', handle: 'acme' });

    await expect(api.status.pages({ workspaceId: ws.id, projectId: project.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('manages a page end to end and maps domain errors', async () => {
    const { api, scope } = await setup('owner@example.com', 'acme');
    const ids = await seed(api, scope, 'acme');

    await api.status.setComponentStatus({ ...scope, componentId: ids.componentId, status: 'degraded' });
    await api.status.createComponent({ ...scope, pageId: ids.pageId, name: 'Dashboard' });
    await api.status.deleteGroup({ ...scope, groupId: ids.groupId });
    const detail = await api.status.page({ ...scope, pageId: ids.pageId });

    expect(detail.groups).toEqual([]);
    expect(detail.components.map(row => [row.name, row.status, row.groupId])).toEqual([
      ['API', 'degraded', null],
      ['Dashboard', 'operational', null],
    ]);
    await expect(api.status.createPage({ ...scope, slug: 'acme', title: 'Again' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(api.status.createPage({ ...scope, slug: 'Not A Slug', title: 'x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await api.status.deletePage({ ...scope, pageId: ids.pageId });
    await expect(api.status.page({ ...scope, pageId: ids.pageId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('covers every status procedure in the cross-tenant table', () => {
    expect(new Set(Object.keys(calls))).toEqual(new Set(Object.keys(statusRouter._def.procedures)));
  });

  it("rejects a non-member and another tenant's ids on every procedure", async () => {
    const owner = await setup('owner@example.com', 'acme');
    const victim = await seed(owner.api, owner.scope, 'acme');
    const attacker = await setup('attacker@example.com', 'evil');
    const own = await seed(attacker.api, attacker.scope, 'evil');

    const results: Record<string, [string | undefined, string | undefined]> = {};
    // One at a time: the calls share one pglite connection.
    await Object.entries(calls).reduce(async (previous, [name, call]) => {
      await previous;
      // The victim's workspace and project: the membership check rejects before any resolver.
      const asNonMember = await outcome(async () => await call(attacker.api, owner.scope, victim));
      // The attacker's own scope with the victim's ids: the scoped lookups find nothing.
      const withForeignIds = scopeOnly.has(name)
        ? 'n/a'
        : await outcome(async () => await call(attacker.api, attacker.scope, victim));
      results[name] = [asNonMember, withForeignIds];
    }, Promise.resolve());

    expect(results).toEqual(
      Object.fromEntries(
        Object.keys(calls).map(name => [name, ['NOT_FOUND', scopeOnly.has(name) ? 'n/a' : 'NOT_FOUND']]),
      ),
    );
    // The victim's data is untouched, and the attacker's own data still works.
    const detail = await owner.api.status.page({ ...owner.scope, pageId: victim.pageId });
    expect(detail.page.slug).toBe('acme');
    expect(detail.components).toEqual([
      expect.objectContaining({ name: 'API', status: 'operational', groupId: victim.groupId }),
    ]);
    const ownPage = await attacker.api.status.page({ ...attacker.scope, pageId: own.pageId });
    expect(ownPage.page.slug).toBe('evil');
    const { pages } = await attacker.api.status.pages(attacker.scope);
    expect(pages.map(page => page.id)).not.toContain(victim.pageId);
  });
});
