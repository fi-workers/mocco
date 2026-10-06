// /v1/feedback (#174) end to end on pglite: key scopes, end-user tokens (expired, another
// project's, too long-lived, none), the public projection (private boards, merged
// duplicates, internal notes, the team's ids, emails), votes, comments and their limits.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { FeedbackPostStatuses, FeedbackVoteSources } from '@mocco/common/feedback';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { EndUserTokenService } from '@backend/domain/enduser/EndUserTokenService';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { FeedbackRateLimits } from '@backend/transport/ext/v1/feedback';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ApiScope } from '@mocco/common/apikey';

const BASE = 'https://www.mocco.test/api/ext/v1/feedback';
const NOW = new Date('2026-10-06T12:00:30Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const EMAIL = 'ada.lovelace@example.com';

type Json = Record<string, unknown>;
const byName = (left: string, right: string) => (left < right ? -1 : 1);

/** A token the app's server would sign: HS256 with the project's identity secret. */
const tokenFor = async (
  secret: string,
  sub: string,
  opts: { exp?: number; email?: string; alg?: string } = {},
): Promise<string> =>
  await new SignJWT({ email: opts.email ?? EMAIL, name: 'Ada' })
    .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
    .setSubject(sub)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(opts.exp ?? nowSeconds + 15 * 60)
    .sign(new TextEncoder().encode(secret));

describe('/v1/feedback (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let operatorId: string;
  let secret: string;
  let key: string;
  let boardId: string;
  let messengerDomain: ReturnType<typeof createMessengerDomain>;
  let apiKeys: ReturnType<typeof createApiKeyService>;

  const call = async (
    method: string,
    path: string,
    opts: { key?: string; token?: string; body?: unknown; ip?: string } = {},
  ) => {
    const response = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(opts.key !== undefined && { 'x-mocco-key': opts.key }),
          ...(opts.token !== undefined && { authorization: `Bearer ${opts.token}` }),
          ...(opts.ip !== undefined && { 'x-forwarded-for': opts.ip }),
          'content-type': 'application/json',
        },
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      body: text === '' ? {} : (JSON.parse(text) as Json),
    };
  };
  const statusOf = async (...args: Parameters<typeof call>) => {
    const answer = await call(...args);
    return answer.status;
  };
  const bodyOf = async (...args: Parameters<typeof call>) => {
    const answer = await call(...args);
    return answer.body;
  };
  const keyWith = async (scopes: ApiScope[], projectId = scope.projectId) => {
    const created = await apiKeys.create(scope.workspaceId, projectId, operatorId, {
      kind: ApiKeyKinds.publishable,
      name: 'app',
      scopes,
      expiresAt: null,
      flagEnvironmentId: null,
    });
    return created.token;
  };
  const post = async (
    title: string,
    extra: { status?: (typeof FeedbackPostStatuses)[keyof typeof FeedbackPostStatuses]; categoryId?: string } = {},
  ) => await feedback.feedbackPosts.create(scope, operatorId, { boardId, title, ...extra });

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    messengerDomain = createMessengerDomain(t.db, { audit, box: () => box, appOrigin: 'https://mocco.test' });
    feedback = createFeedbackDomain(t.db, { audit, now: () => NOW });
    const { projects } = createProjectDomain(t.db);
    apiKeys = createApiKeyService(t.db, { projects, audit });
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys,
        // A fixed clock: a run that crosses a window boundary would reset the counts.
        limiter: new MemoryRateLimiter(() => NOW),
        feedback: {
          boards: feedback.feedbackPublic,
          endUsers: new EndUserTokenService({ secrets: messengerDomain.messengerSettings, now: () => NOW }),
        },
      }),
    );
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    operatorId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Grace' })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
    ({ identitySecret: secret } = await messengerDomain.messengerSettings.enable(workspaceId, project.id, operatorId));
    key = await keyWith([ApiScopes.feedbackRead, ApiScopes.feedbackWrite]);
    ({ id: boardId } = await feedback.feedbackBoards.createBoard(scope, operatorId, { slug: 'ideas', name: 'Ideas' }));
  });
  afterEach(async () => {
    await t.close();
  });

  describe('keys', () => {
    it('needs a key with feedback:read to read and feedback:write to vote', async () => {
      const { id } = await post('Dark mode');
      expect(await statusOf('GET', '/boards/ideas')).toBe(401);
      const other = await keyWith([ApiScopes.helpRead]);
      expect(await statusOf('GET', '/boards/ideas', { key: other })).toBe(403);
      const reader = await keyWith([ApiScopes.feedbackRead]);
      expect(await statusOf('GET', '/boards/ideas', { key: reader })).toBe(200);
      const vote = await call('POST', `/posts/${id}/vote`, { key: reader, token: await tokenFor(secret, 'u1') });
      expect(vote.status).toBe(403);
    });

    it('still takes the key as the bearer when no end-user token comes with it', async () => {
      const response = await app.fetch(
        new Request(`${BASE}/boards/ideas`, { headers: { authorization: `Bearer ${key}` } }),
      );
      expect(response.status).toBe(200);
    });
  });

  describe('end-user tokens', () => {
    let postId: string;
    beforeEach(async () => {
      ({ id: postId } = await post('Dark mode'));
    });
    const voteWith = async (token?: string) =>
      await call('POST', `/posts/${postId}/vote`, { key, ...(token !== undefined && { token }) });
    const voteStatus = async (token: string) => {
      const answer = await voteWith(token);
      return answer.status;
    };

    it('refuses a write without a token', async () => {
      const response = await voteWith();
      expect(response.status).toBe(401);
      expect(response.body.type).toBe('https://mocco.dev/problems/missing_end_user_token');
    });

    it('refuses an expired token', async () => {
      const response = await voteWith(await tokenFor(secret, 'u1', { exp: nowSeconds - 120 }));
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        type: 'https://mocco.dev/problems/invalid_end_user_token',
        title: 'The end-user token has expired',
      });
    });

    it('takes a token that expired within the minute of clock skew', async () => {
      expect(await voteStatus(await tokenFor(secret, 'u1', { exp: nowSeconds - 30 }))).toBe(200);
    });

    it("refuses another project's token", async () => {
      const otherProject = await createProjectDomain(t.db).projects.create(scope.workspaceId, {
        name: 'Other',
        handle: 'other',
      });
      const { identitySecret } = await messengerDomain.messengerSettings.enable(
        scope.workspaceId,
        otherProject.id,
        operatorId,
      );
      const response = await voteWith(await tokenFor(identitySecret, 'u1'));
      expect(response.status).toBe(401);
      expect(response.body.type).toBe('https://mocco.dev/problems/invalid_end_user_token');
      const { voteCount } = await feedback.feedbackPosts.requirePost(scope, postId);
      expect(voteCount).toBe(0);
    });

    it('refuses a token valid for more than an hour, another algorithm, or garbage', async () => {
      expect(await voteStatus(await tokenFor(secret, 'u1', { exp: nowSeconds + 3 * 60 * 60 }))).toBe(401);
      expect(await voteStatus(await tokenFor(secret, 'u1', { alg: 'HS512' }))).toBe(401);
      expect(await voteStatus('not-a-jwt')).toBe(401);
    });

    it('refuses a bad token on a read too, rather than reading as nobody', async () => {
      const response = await call('GET', `/posts/${postId}`, {
        key,
        token: await tokenFor(secret, 'u1', { exp: nowSeconds - 120 }),
      });
      expect(response.status).toBe(401);
    });

    it('refuses tokens while the project has no identity secret', async () => {
      const otherProject = await createProjectDomain(t.db).projects.create(scope.workspaceId, {
        name: 'Bare',
        handle: 'bare',
      });
      const bareKey = await keyWith([ApiScopes.feedbackRead, ApiScopes.feedbackWrite], otherProject.id);
      const response = await call('POST', `/posts/${postId}/vote`, {
        key: bareKey,
        token: await tokenFor(secret, 'u1'),
      });
      expect(response.status).toBe(401);
      expect(response.body.title).toBe('This project has no identity secret to verify end-user tokens with');
    });
  });

  describe('reads', () => {
    it("serves a public board with its categories, and no private or other project's board", async () => {
      await feedback.feedbackBoards.createCategory(scope, boardId, { slug: 'ui', name: 'UI' });
      const board = await call('GET', '/boards/ideas', { key });
      expect(board.status).toBe(200);
      expect(board.body).toEqual({
        board: { slug: 'ideas', name: 'Ideas', categories: [{ id: expect.any(String), slug: 'ui', name: 'UI' }] },
      });
      await feedback.feedbackBoards.createBoard(scope, operatorId, { slug: 'secret', name: 'Secret', isPublic: false });
      expect(await statusOf('GET', '/boards/secret', { key })).toBe(404);
      expect(await statusOf('GET', '/boards/secret/posts', { key })).toBe(404);
      expect(await statusOf('GET', '/boards/nope', { key })).toBe(404);
      const other = await createProjectDomain(t.db).projects.create(scope.workspaceId, { name: 'O', handle: 'o' });
      expect(await statusOf('GET', '/boards/ideas', { key: await keyWith([ApiScopes.feedbackRead], other.id) })).toBe(
        404,
      );
    });

    it('lists posts most voted or newest first, filtered, paged, without merged duplicates', async () => {
      const ui = await feedback.feedbackBoards.createCategory(scope, boardId, { slug: 'ui', name: 'UI' });
      const older = await post('Older', { categoryId: ui.id });
      const voted = await post('Voted');
      const duplicate = await post('Duplicate');
      await feedback.feedbackVotes.vote(scope, voted.id, 'u1', { source: FeedbackVoteSources.web });
      await feedback.feedbackMerges.merge(scope, operatorId, duplicate.id, voted.id);

      const top = await call('GET', '/boards/ideas/posts', { key });
      expect((top.body.posts as Json[]).map(row => row.title)).toEqual(['Voted', 'Older']);
      expect(top.body.nextOffset).toBeNull();
      const newest = await call('GET', '/boards/ideas/posts?sort=new&limit=1', { key });
      expect((newest.body.posts as Json[]).map(row => row.title)).toEqual(['Voted']);
      expect(newest.body.nextOffset).toBe(1);
      const byCategory = await call('GET', '/boards/ideas/posts?category=ui', { key });
      expect((byCategory.body.posts as Json[]).map(row => row.id)).toEqual([older.id]);
      expect(await statusOf('GET', '/boards/ideas/posts?category=nope', { key })).toBe(404);
      expect(await statusOf('GET', '/boards/ideas/posts?sort=trending', { key })).toBe(400);
      const planned = await call('GET', `/boards/ideas/posts?status=${FeedbackPostStatuses.planned}`, { key });
      expect(planned.body.posts).toEqual([]);

      // The duplicate itself still answers, pointing at the post it was merged into.
      const merged = await call('GET', `/posts/${duplicate.id}`, { key });
      expect(merged.body.post).toMatchObject({ id: duplicate.id, mergedIntoPostId: voted.id });
      const vote = await call('POST', `/posts/${duplicate.id}/vote`, { key, token: await tokenFor(secret, 'u2') });
      expect(vote.status).toBe(409);
      expect(vote.body.detail).toBe(`mergedIntoPostId: ${voted.id}`);
    });

    it('groups the roadmap by column', async () => {
      await post('Idea');
      await post('Next', { status: FeedbackPostStatuses.planned });
      await post('Now', { status: FeedbackPostStatuses.inProgress });
      await post('Done', { status: FeedbackPostStatuses.shipped });
      const response = await call('GET', '/boards/ideas/roadmap', { key });
      expect(response.status).toBe(200);
      const { roadmap } = response.body as { roadmap: Record<string, Json[]> };
      expect(
        Object.fromEntries(Object.entries(roadmap).map(([column, posts]) => [column, posts.map(p => p.title)])),
      ).toEqual({
        planned: ['Next'],
        in_progress: ['Now'],
        shipped: ['Done'],
      });
    });

    it("hides a private board's posts and answers 404 for a malformed id", async () => {
      const hidden = await feedback.feedbackBoards.createBoard(scope, operatorId, {
        slug: 'hidden',
        name: 'Hidden',
        isPublic: false,
      });
      const secretPost = await feedback.feedbackPosts.create(scope, operatorId, {
        boardId: hidden.id,
        title: 'Secret',
      });
      expect(await statusOf('GET', `/posts/${secretPost.id}`, { key })).toBe(404);
      expect(await statusOf('GET', `/posts/${secretPost.id}/comments`, { key })).toBe(404);
      const vote = await call('POST', `/posts/${secretPost.id}/vote`, { key, token: await tokenFor(secret, 'u1') });
      expect(vote.status).toBe(404);
      expect(await statusOf('GET', '/posts/not-a-uuid', { key })).toBe(404);
    });
  });

  describe('the public projection', () => {
    it('never serves internal notes, the team, other end users or the email a token carries', async () => {
      const { id } = await post('Dark mode');
      await feedback.feedbackComments.createAsStaff(scope, operatorId, id, {
        body: 'INTERNAL: the big customer asked',
        isOfficial: false,
        isInternal: true,
      });
      await feedback.feedbackComments.createAsStaff(scope, operatorId, id, {
        body: 'We are on it',
        isOfficial: true,
        isInternal: false,
      });
      await feedback.feedbackComments.createAsEndUser(scope, id, 'someone-else@their-app', 'Me too');
      const ada = await tokenFor(secret, 'ada-1', { email: EMAIL });
      const mine = await call('POST', `/posts/${id}/comments`, { key, token: ada, body: { body: 'Please!' } });
      expect(mine.status).toBe(201);
      await call('POST', `/posts/${id}/vote`, { key, token: ada });

      const answers = [
        mine,
        await call('GET', '/boards/ideas', { key }),
        await call('GET', '/boards/ideas/posts', { key }),
        await call('GET', '/boards/ideas/roadmap', { key }),
        await call('GET', `/posts/${id}`, { key, token: ada }),
        await call('GET', `/posts/${id}/comments`, { key }),
        await call('GET', `/posts/${id}/comments`, { key, token: ada }),
      ];
      expect(answers.map(answer => answer.status).every(status => status < 300)).toBe(true);
      const served = answers.map(answer => answer.text).join('\n');
      expect(served).toContain('We are on it');
      expect(served).not.toContain('INTERNAL');
      expect(served).not.toContain(operatorId);
      expect(served).not.toContain(EMAIL);
      expect(served).not.toContain('someone-else@their-app');
      expect(served).not.toContain('ada-1');
      expect(served).not.toMatch(/authorUserId|authorEndUserId|isInternal|workspaceId|projectId|boardId/u);

      const comments = (answers[6]?.body.comments ?? []) as Json[];
      expect(
        comments.map(({ body, authorKind, isOfficial, isMine }) => ({ body, authorKind, isOfficial, isMine })),
      ).toEqual([
        { body: 'We are on it', authorKind: 'staff', isOfficial: true, isMine: false },
        { body: 'Me too', authorKind: 'end_user', isOfficial: false, isMine: false },
        { body: 'Please!', authorKind: 'end_user', isOfficial: false, isMine: true },
      ]);
      expect(Object.keys(answers[4]?.body.post as Json).toSorted(byName)).toEqual(
        [
          'body',
          'categoryId',
          'commentCount',
          'createdAt',
          'id',
          'mergedIntoPostId',
          'number',
          'shippedAt',
          'status',
          'title',
          'voteCount',
        ].toSorted(byName),
      );
      expect(answers[4]?.body.post).toMatchObject({ commentCount: 3, voteCount: 1 });
    });
  });

  describe('votes and comments', () => {
    it('counts a signed-in vote once, shows it to its voter, and takes it back', async () => {
      const { id } = await post('Dark mode');
      const token = await tokenFor(secret, 'u1');
      const first = await call('POST', `/posts/${id}/vote`, { key, token });
      expect(first).toMatchObject({ status: 200, body: { vote: 'counted', voteCount: 1 } });
      const again = await call('POST', `/posts/${id}/vote`, { key, token, body: { source: 'web' } });
      expect(again.body).toEqual({ vote: 'counted', voteCount: 1 });
      const seen = await bodyOf('GET', `/posts/${id}`, { key, token });
      expect(seen.viewer).toEqual({ vote: 'counted' });
      const anonymous = await bodyOf('GET', `/posts/${id}`, { key });
      expect(anonymous.viewer).toBeNull();
      const other = await call('GET', `/posts/${id}`, { key, token: await tokenFor(secret, 'u2') });
      expect(other.body.viewer).toEqual({ vote: null });
      expect(await bodyOf('DELETE', `/posts/${id}/vote`, { key, token })).toEqual({ vote: null, voteCount: 0 });
      expect(await statusOf('POST', `/posts/${id}/vote`, { key, token, body: { source: 'staff' } })).toBe(400);
    });

    it('refuses an empty comment', async () => {
      const { id } = await post('Dark mode');
      const response = await call('POST', `/posts/${id}/comments`, {
        key,
        token: await tokenFor(secret, 'u1'),
        body: { body: '  ' },
      });
      expect(response.status).toBe(400);
    });

    it("limits an end user's votes and comments an hour, and each client address", async () => {
      const { id } = await post('Dark mode');
      const token = await tokenFor(secret, 'u1');
      const { limit } = FeedbackRateLimits.votes;
      const statuses = await Array.from({ length: limit }).reduce<Promise<number[]>>(async (previous, _, index) => {
        const done = await previous;
        const response = await call(index % 2 === 0 ? 'POST' : 'DELETE', `/posts/${id}/vote`, { key, token });
        return [...done, response.status];
      }, Promise.resolve([]));
      expect(statuses.every(status => status === 200)).toBe(true);
      const refused = await call('POST', `/posts/${id}/vote`, { key, token });
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).not.toBeNull();
      // Another end user is limited on their own.
      expect(await statusOf('POST', `/posts/${id}/vote`, { key, token: await tokenFor(secret, 'u2') })).toBe(200);

      const commenter = await tokenFor(secret, 'u3');
      const comments = await Array.from({ length: FeedbackRateLimits.comments.limit }).reduce<Promise<number[]>>(
        async previous => {
          const done = await previous;
          const response = await call('POST', `/posts/${id}/comments`, { key, token: commenter, body: { body: 'x' } });
          return [...done, response.status];
        },
        Promise.resolve([]),
      );
      expect(comments.every(status => status === 201)).toBe(true);
      expect(await statusOf('POST', `/posts/${id}/comments`, { key, token: commenter, body: { body: 'x' } })).toBe(429);
    });

    it('limits every write from one client address, whoever signs in', async () => {
      const { id } = await post('Dark mode');
      const { limit } = FeedbackRateLimits.writesPerAddress;
      const ip = '203.0.113.9';
      const statuses = await Array.from({ length: limit }).reduce<Promise<number[]>>(async (previous, _, index) => {
        const done = await previous;
        const response = await call('POST', `/posts/${id}/vote`, {
          key,
          token: await tokenFor(secret, `user-${index}`),
          ip,
        });
        return [...done, response.status];
      }, Promise.resolve([]));
      expect(statuses.every(status => status === 200)).toBe(true);
      const refused = await call('POST', `/posts/${id}/vote`, { key, token: await tokenFor(secret, 'one-more'), ip });
      expect(refused.status).toBe(429);
      const elsewhere = await statusOf('POST', `/posts/${id}/vote`, {
        key,
        token: await tokenFor(secret, 'one-more'),
        ip: '203.0.113.10',
      });
      expect(elsewhere).toBe(200);
    });
  });
});
