import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import {
  FeedbackPostSorts,
  FeedbackPostStatuses,
  FeedbackStatusChangeReasons,
  FeedbackVoteSources,
  FeedbackVoteStates,
} from '@mocco/common/feedback';
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
import { feedbackRouter } from '@backend/transport/trpc/routers/feedback';
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
  boardId: string;
  categoryId: string;
  postId: string;
}

/** One call per feedback procedure: `scope` is the tenant the caller claims, `ids` the entities it targets. */
const calls: Record<string, (api: Api, scope: Scope, ids: Ids) => Promise<unknown>> = {
  boards: async (api, scope) => await api.feedback.boards(scope),
  board: async (api, scope, ids) => await api.feedback.board({ ...scope, boardId: ids.boardId }),
  createBoard: async (api, scope) => await api.feedback.createBoard({ ...scope, slug: 'attacker', name: 'x' }),
  updateBoard: async (api, scope, ids) =>
    await api.feedback.updateBoard({ ...scope, boardId: ids.boardId, slug: 'taken-over', name: 'x' }),
  deleteBoard: async (api, scope, ids) => await api.feedback.deleteBoard({ ...scope, boardId: ids.boardId }),
  createCategory: async (api, scope, ids) =>
    await api.feedback.createCategory({ ...scope, boardId: ids.boardId, slug: 'attacker', name: 'x' }),
  updateCategory: async (api, scope, ids) =>
    await api.feedback.updateCategory({ ...scope, categoryId: ids.categoryId, slug: 'taken-over', name: 'x' }),
  deleteCategory: async (api, scope, ids) =>
    await api.feedback.deleteCategory({ ...scope, categoryId: ids.categoryId }),
  posts: async (api, scope, ids) => await api.feedback.posts({ ...scope, boardId: ids.boardId }),
  post: async (api, scope, ids) => await api.feedback.post({ ...scope, postId: ids.postId }),
  createPost: async (api, scope, ids) => await api.feedback.createPost({ ...scope, boardId: ids.boardId, title: 'x' }),
  updatePost: async (api, scope, ids) => await api.feedback.updatePost({ ...scope, postId: ids.postId, title: 'x' }),
  setPostStatus: async (api, scope, ids) =>
    await api.feedback.setPostStatus({ ...scope, postId: ids.postId, status: FeedbackPostStatuses.closed }),
  votes: async (api, scope, ids) => await api.feedback.votes({ ...scope, postId: ids.postId }),
  vote: async (api, scope, ids) => await api.feedback.vote({ ...scope, postId: ids.postId, endUserId: 'stuffed' }),
  unvote: async (api, scope, ids) => await api.feedback.unvote({ ...scope, postId: ids.postId, endUserId: 'voter' }),
  comments: async (api, scope, ids) => await api.feedback.comments({ ...scope, postId: ids.postId }),
  createComment: async (api, scope, ids) =>
    await api.feedback.createComment({ ...scope, postId: ids.postId, body: 'x', isOfficial: true }),
  subscribers: async (api, scope, ids) => await api.feedback.subscribers({ ...scope, postId: ids.postId }),
  mergePost: async (api, scope, ids) =>
    await api.feedback.mergePost({ ...scope, postId: ids.postId, intoPostId: randomUUID() }),
};

/** Procedures that take no entity id: with the caller's own scope they act on the caller's own data. */
const scopeOnly = new Set(['boards', 'createBoard']);

/** The tRPC error code a call ends with, or 'ok'. */
const outcome = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

/** A board with a category and a categorized post, which one end user voted for. */
const seed = async (api: Api, scope: Scope, slug: string): Promise<Ids> => {
  const { board } = await api.feedback.createBoard({ ...scope, slug, name: 'Ideas' });
  const { category } = await api.feedback.createCategory({ ...scope, boardId: board.id, slug: 'mobile', name: 'M' });
  const { post } = await api.feedback.createPost({
    ...scope,
    boardId: board.id,
    title: 'Dark mode',
    categoryId: category.id,
  });
  await api.feedback.vote({ ...scope, postId: post.id, endUserId: 'voter' });
  return { boardId: board.id, categoryId: category.id, postId: post.id };
};

describe('feedback router on pglite', () => {
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

  it('requires the feedback product', async () => {
    const api = await signedInCaller('owner@example.com');
    const { workspace: ws } = await api.workspace.create({ name: 'W' });
    const { project } = await api.project.create({ workspaceId: ws.id, name: 'Acme', handle: 'acme' });

    await expect(api.feedback.boards({ workspaceId: ws.id, projectId: project.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('runs a board end to end and maps domain errors', async () => {
    const { api, scope } = await setup('owner@example.com', 'acme');
    const ids = await seed(api, scope, 'ideas');

    const { post, change } = await api.feedback.setPostStatus({
      ...scope,
      postId: ids.postId,
      status: FeedbackPostStatuses.planned,
    });
    expect(post.status).toBe(FeedbackPostStatuses.planned);
    expect(change).toMatchObject({
      fromStatus: FeedbackPostStatuses.underReview,
      toStatus: FeedbackPostStatuses.planned,
    });
    await api.feedback.createPost({ ...scope, boardId: ids.boardId, title: 'Export CSV' });
    const { posts } = await api.feedback.posts({ ...scope, boardId: ids.boardId });
    expect(posts.map(row => [row.number, row.status])).toEqual([
      [2, FeedbackPostStatuses.underReview],
      [1, FeedbackPostStatuses.planned],
    ]);
    const newest = await api.feedback.posts({ ...scope, boardId: ids.boardId, sort: FeedbackPostSorts.newest });
    expect(newest.posts.map(row => row.number)).toEqual([2, 1]);
    const detail = await api.feedback.post({ ...scope, postId: ids.postId });
    expect(detail.history.map(row => row.reason)).toEqual([
      FeedbackStatusChangeReasons.created,
      FeedbackStatusChangeReasons.manual,
    ]);
    const { categories } = await api.feedback.board({ ...scope, boardId: ids.boardId });
    expect(categories.map(row => row.slug)).toEqual(['mobile']);

    await expect(
      api.feedback.setPostStatus({ ...scope, postId: ids.postId, status: FeedbackPostStatuses.planned }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(api.feedback.createBoard({ ...scope, slug: 'ideas', name: 'Again' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(api.feedback.createBoard({ ...scope, slug: 'Not A Slug', name: 'x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await api.feedback.deleteBoard({ ...scope, boardId: ids.boardId });
    await expect(api.feedback.post({ ...scope, postId: ids.postId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('records votes on behalf of end users and takes the team comments', async () => {
    const { api, scope } = await setup('owner@example.com', 'acme');
    const ids = await seed(api, scope, 'ideas');

    const again = await api.feedback.vote({ ...scope, postId: ids.postId, endUserId: 'voter' });
    expect(again.post.voteCount).toBe(1);
    const second = await api.feedback.vote({ ...scope, postId: ids.postId, endUserId: 'customer-42' });
    expect(second.vote).toMatchObject({ source: FeedbackVoteSources.staff, state: FeedbackVoteStates.counted });
    expect(second.post.voteCount).toBe(2);
    const { votes } = await api.feedback.votes({ ...scope, postId: ids.postId });
    expect(votes.map(vote => vote.endUserId)).toEqual(['customer-42', 'voter']);
    const unvoted = await api.feedback.unvote({ ...scope, postId: ids.postId, endUserId: 'voter' });
    expect(unvoted.post.voteCount).toBe(1);

    const { comment } = await api.feedback.createComment({
      ...scope,
      postId: ids.postId,
      body: 'Planned for Q4',
      isOfficial: true,
    });
    expect(comment).toMatchObject({ isOfficial: true, isInternal: false });
    await api.feedback.createComment({ ...scope, postId: ids.postId, body: 'Needs design', isInternal: true });
    const { comments } = await api.feedback.comments({ ...scope, postId: ids.postId });
    expect(comments.map(row => [row.body, row.isInternal])).toEqual([
      ['Planned for Q4', false],
      ['Needs design', true],
    ]);
    await expect(
      api.feedback.createComment({ ...scope, postId: ids.postId, body: 'x', isOfficial: true, isInternal: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.feedback.vote({ ...scope, postId: ids.postId, endUserId: ' ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('merges a duplicate, lists subscribers and maps merge errors', async () => {
    const { api, scope } = await setup('owner@example.com', 'acme');
    const ids = await seed(api, scope, 'ideas');
    const { post: duplicate } = await api.feedback.createPost({ ...scope, boardId: ids.boardId, title: 'Dark theme' });
    await api.feedback.vote({ ...scope, postId: duplicate.id, endUserId: 'voter' });
    await api.feedback.vote({ ...scope, postId: duplicate.id, endUserId: 'other' });

    const { source, target } = await api.feedback.mergePost({ ...scope, postId: duplicate.id, intoPostId: ids.postId });
    expect(source).toMatchObject({ mergedIntoPostId: ids.postId, status: FeedbackPostStatuses.closed });
    expect(target.voteCount).toBe(2);
    const { subscribers } = await api.feedback.subscribers({ ...scope, postId: ids.postId });
    expect(subscribers.map(row => row.endUserId)).toEqual(['voter', 'other']);

    await expect(
      api.feedback.mergePost({ ...scope, postId: ids.postId, intoPostId: duplicate.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(api.feedback.vote({ ...scope, postId: duplicate.id, endUserId: 'late' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      api.feedback.mergePost({ ...scope, postId: ids.postId, intoPostId: ids.postId }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('covers every feedback procedure in the cross-tenant table', () => {
    expect(new Set(Object.keys(calls))).toEqual(new Set(Object.keys(feedbackRouter._def.procedures)));
  });

  it("rejects a non-member and another tenant's ids on every procedure", async () => {
    const owner = await setup('owner@example.com', 'acme');
    const victim = await seed(owner.api, owner.scope, 'ideas');
    const attacker = await setup('attacker@example.com', 'evil');
    const own = await seed(attacker.api, attacker.scope, 'ideas');

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
    const board = await owner.api.feedback.board({ ...owner.scope, boardId: victim.boardId });
    expect(board.board).toMatchObject({ slug: 'ideas', name: 'Ideas' });
    expect(board.categories).toEqual([expect.objectContaining({ id: victim.categoryId, slug: 'mobile' })]);
    const post = await owner.api.feedback.post({ ...owner.scope, postId: victim.postId });
    expect(post.post).toMatchObject({
      title: 'Dark mode',
      status: FeedbackPostStatuses.underReview,
      categoryId: victim.categoryId,
    });
    expect(post.history).toHaveLength(1);
    expect(post.post).toMatchObject({ voteCount: 1, commentCount: 0 });
    const { votes } = await owner.api.feedback.votes({ ...owner.scope, postId: victim.postId });
    expect(votes.map(vote => vote.endUserId)).toEqual(['voter']);
    const { comments } = await owner.api.feedback.comments({ ...owner.scope, postId: victim.postId });
    expect(comments).toEqual([]);
    // Merging the attacker's own post into the victim's would move votes across tenants.
    await expect(
      attacker.api.feedback.mergePost({ ...attacker.scope, postId: own.postId, intoPostId: victim.postId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const afterMerge = await owner.api.feedback.post({ ...owner.scope, postId: victim.postId });
    expect(afterMerge.post.voteCount).toBe(1);
    const { subscribers } = await owner.api.feedback.subscribers({ ...owner.scope, postId: victim.postId });
    expect(subscribers.map(row => row.endUserId)).toEqual(['voter']);
    const { posts } = await owner.api.feedback.posts({ ...owner.scope, boardId: victim.boardId });
    expect(posts.map(row => row.id)).toEqual([victim.postId]);
    const { boards } = await attacker.api.feedback.boards(attacker.scope);
    expect(boards.map(row => row.id)).not.toContain(victim.boardId);
    expect(boards.map(row => row.id)).toContain(own.boardId);
  });
});
