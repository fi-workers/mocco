import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { ChangelogEntryStates } from '@mocco/common/feedback';
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
import { changelogRouter } from '@backend/transport/trpc/routers/changelog';
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

/** The tRPC error code a call ends with, or 'ok'. */
const outcome = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

interface Ids {
  boardId: string;
  postId: string;
  entryId: string;
}

/** A board with a post and a draft entry announcing it. */
const seed = async (api: Api, scope: Scope): Promise<Ids> => {
  const { board } = await api.feedback.createBoard({ ...scope, slug: 'ideas', name: 'Ideas' });
  const { post } = await api.feedback.createPost({ ...scope, boardId: board.id, title: 'Dark mode' });
  const { entry } = await api.changelog.create({ ...scope, boardId: board.id, title: 'Dark mode', postIds: [post.id] });
  return { boardId: board.id, postId: post.id, entryId: entry.id };
};

const AHEAD = new Date(Date.now() + 24 * 60 * 60 * 1000);

/** Every changelog procedure, called with a scope and another tenant's (or its own) ids. */
const calls: Record<string, (api: Api, scope: Scope, ids: Ids) => Promise<unknown>> = {
  entries: async (api, scope, ids) => await api.changelog.entries({ ...scope, boardId: ids.boardId }),
  entry: async (api, scope, ids) => await api.changelog.entry({ ...scope, entryId: ids.entryId }),
  create: async (api, scope, ids) => await api.changelog.create({ ...scope, boardId: ids.boardId, title: 'x' }),
  update: async (api, scope, ids) => await api.changelog.update({ ...scope, entryId: ids.entryId, title: 'x' }),
  publish: async (api, scope, ids) => await api.changelog.publish({ ...scope, entryId: ids.entryId }),
  schedule: async (api, scope, ids) =>
    await api.changelog.schedule({ ...scope, entryId: ids.entryId, publishAt: AHEAD }),
  unpublish: async (api, scope, ids) => await api.changelog.unpublish({ ...scope, entryId: ids.entryId }),
  delete: async (api, scope, ids) => await api.changelog.delete({ ...scope, entryId: ids.entryId }),
};

describe('changelog router on pglite', () => {
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
        /* feedback tests don't exercise the run loop */
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
    await api.product.enable({ workspaceId: ws.id, product: Products.feedback });
    return { api, scope };
  };

  it('runs an entry from draft to published and back, and maps domain errors', async () => {
    const { api, scope } = await setup('owner@example.com', 'acme');
    const ids = await seed(api, scope);
    const { entries } = await api.changelog.entries({ ...scope, boardId: ids.boardId });
    expect(entries).toEqual([expect.objectContaining({ id: ids.entryId, slug: 'dark-mode', postIds: [ids.postId] })]);
    const { entry: scheduled } = await api.changelog.schedule({ ...scope, entryId: ids.entryId, publishAt: AHEAD });
    expect(scheduled.state).toBe(ChangelogEntryStates.scheduled);
    const { entry: published } = await api.changelog.publish({ ...scope, entryId: ids.entryId });
    expect(published).toMatchObject({ state: ChangelogEntryStates.published, publishAt: null });
    await expect(api.changelog.publish({ ...scope, entryId: ids.entryId })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.changelog.schedule({ ...scope, entryId: ids.entryId, publishAt: new Date(Date.now() - 1000) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.changelog.create({ ...scope, boardId: ids.boardId, title: 'x', slug: 'dark-mode' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.changelog.update({ ...scope, entryId: ids.entryId, postIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const { entry: draft } = await api.changelog.unpublish({ ...scope, entryId: ids.entryId });
    expect(draft.state).toBe(ChangelogEntryStates.draft);
    await api.changelog.delete({ ...scope, entryId: ids.entryId });
    await expect(api.changelog.entry({ ...scope, entryId: ids.entryId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('covers every changelog procedure in the cross-tenant table', () => {
    expect(new Set(Object.keys(calls))).toEqual(new Set(Object.keys(changelogRouter._def.procedures)));
  });

  it("rejects a non-member and another tenant's ids on every procedure", async () => {
    const owner = await setup('owner@example.com', 'acme');
    const victim = await seed(owner.api, owner.scope);
    const attacker = await setup('attacker@example.com', 'evil');
    await seed(attacker.api, attacker.scope);

    const results: Record<string, [string | undefined, string | undefined]> = {};
    // One at a time: the calls share one pglite connection.
    await Object.entries(calls).reduce(async (previous, [name, call]) => {
      await previous;
      const asNonMember = await outcome(async () => await call(attacker.api, owner.scope, victim));
      const withForeignIds = await outcome(async () => await call(attacker.api, attacker.scope, victim));
      results[name] = [asNonMember, withForeignIds];
    }, Promise.resolve());

    expect(results).toEqual(Object.fromEntries(Object.keys(calls).map(name => [name, ['NOT_FOUND', 'NOT_FOUND']])));
    // The victim's entry is untouched.
    const { entry } = await owner.api.changelog.entry({ ...owner.scope, entryId: victim.entryId });
    expect(entry).toMatchObject({ title: 'Dark mode', state: ChangelogEntryStates.draft, postIds: [victim.postId] });
  });
});
