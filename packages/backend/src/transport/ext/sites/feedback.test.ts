// The public feedback board pages (#175) on pglite: their data (transport/sites/feedback.ts) and
// the routes they call from the browser (/api/ext/sites/:site/feedback). The site names the
// project; a private board, a post on it and another project's post are not there; a merged
// duplicate points at its target; and nothing outside the public projection (an internal note,
// a team member's id, an end user's id or email) reaches a page or an answer.
import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { EndUserTokenService } from '@backend/domain/enduser/EndUserTokenService';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createFeedbackSiteRoutes } from '@backend/transport/ext/sites/feedback';
import { createFeedbackPages } from '@backend/transport/sites/feedback';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { V1Env } from '@backend/transport/ext/v1/middleware';

const BASE = 'https://acme.help.mocco.test/api/ext/sites';
const NOW = new Date('2026-10-06T12:00:30Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const EMAIL = 'ada.lovelace@example.com';
const NOTE = 'Internal: the big customer wants this by Q4';

type Json = Record<string, unknown>;
const byText = (left: string, right: string) => (left < right ? -1 : 1);

const tokenFor = async (secret: string, sub: string): Promise<string> =>
  await new SignJWT({ email: EMAIL, name: 'Ada' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 15 * 60)
    .sign(new TextEncoder().encode(secret));

describe('public feedback board pages (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let feedback: FeedbackDomain;
  let pages: ReturnType<typeof createFeedbackPages>;
  let scope: FeedbackScope;
  let operatorId: string;
  let secret: string;
  let boardId: string;

  const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const response = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(opts.token !== undefined && { authorization: `Bearer ${opts.token}` }),
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

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    const messenger = createMessengerDomain(t.db, { audit, box: () => box, appOrigin: 'https://mocco.test' });
    feedback = createFeedbackDomain(t.db, { audit, now: () => NOW });
    const help = createHelpDomain(t.db, { audit, feedbackSecret: () => 'test-feedback-secret', now: () => NOW });
    const { projects } = createProjectDomain(t.db);
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
    await help.helpSites.enable(workspaceId, project.id, operatorId, { slug: 'acme', sourceLocale: 'en', locales: [] });
    ({ identitySecret: secret } = await messenger.messengerSettings.enable(workspaceId, project.id, operatorId));
    ({ id: boardId } = await feedback.feedbackBoards.createBoard(scope, operatorId, { slug: 'ideas', name: 'Ideas' }));

    pages = createFeedbackPages({
      sites: help.helpPublic,
      boards: feedback.feedbackPublic,
      originOf: site => `https://${site}.help.mocco.test`,
    });
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/sites/:site/feedback',
      createFeedbackSiteRoutes(
        {
          apiKeys: { authenticate: async () => await Promise.reject(new Error('no keys here')) },
          limiter: new MemoryRateLimiter(() => NOW),
        },
        {
          boards: feedback.feedbackPublic,
          endUsers: new EndUserTokenService({ secrets: messenger.messengerSettings, now: () => NOW }),
        },
        { projectOf: async site => await help.helpPublic.projectOf(site) },
      ),
    );
  });
  afterEach(async () => {
    await t.close();
  });

  const post = async (title: string) => await feedback.feedbackPosts.create(scope, operatorId, { boardId, title });

  describe('page data', () => {
    it('lists the board most voted first, under the site and its origin', async () => {
      const quiet = await post('Quiet idea');
      const loud = await post('Loud idea');
      await feedback.feedbackVotes.vote(scope, loud.id, 'u1', { source: 'staff', recordedByUserId: operatorId });
      const page = await pages.boardPage('acme', 'ideas');
      expect(page?.site).toEqual({ slug: 'acme', name: 'Acme', origin: 'https://acme.help.mocco.test' });
      expect(page?.board.name).toBe('Ideas');
      expect(page?.posts.map(item => item.number)).toEqual([loud.number, quiet.number]);
      expect(page?.posts[0]?.voteCount).toBe(1);
    });

    it('has no page for another site, a missing board or a private one', async () => {
      expect(await pages.boardPage('nope', 'ideas')).toBeUndefined();
      expect(await pages.boardPage('acme', 'nope')).toBeUndefined();
      const { number } = await post('Secret idea');
      await feedback.feedbackBoards.updateBoard(scope, boardId, { slug: 'ideas', name: 'Ideas', isPublic: false });
      expect(await pages.boardPage('acme', 'ideas')).toBeUndefined();
      expect(await pages.postPage('acme', 'ideas', number)).toEqual({ kind: 'missing' });
    });

    it('finds a post by its number, and a missing number is no page', async () => {
      const first = await post('Dark mode');
      const result = await pages.postPage('acme', 'ideas', first.number);
      expect(result.kind === 'page' && result.page.post.title).toBe('Dark mode');
      expect(await pages.postPage('acme', 'ideas', first.number + 10)).toEqual({ kind: 'missing' });
    });

    it('sends a merged duplicate to the post it was merged into', async () => {
      const target = await post('Dark mode');
      const duplicate = await post('Night theme');
      await feedback.feedbackMerges.merge(scope, operatorId, duplicate.id, target.id);
      expect(await pages.postPage('acme', 'ideas', duplicate.number)).toEqual({
        kind: 'merged',
        intoNumber: target.number,
      });
      const board = await pages.boardPage('acme', 'ideas');
      expect(board?.posts.map(item => item.number)).toEqual([target.number]);
    });

    it('never carries an internal note, a team id, an end user id or an email', async () => {
      const authored = await feedback.feedbackPosts.createAsEndUser(scope, EMAIL, {
        boardId,
        title: 'From the app',
        source: 'web',
      });
      await feedback.feedbackComments.createAsStaff(scope, operatorId, authored.id, {
        body: NOTE,
        isOfficial: false,
        isInternal: true,
      });
      await feedback.feedbackComments.createAsStaff(scope, operatorId, authored.id, {
        body: 'Planned for next month',
        isOfficial: true,
        isInternal: false,
      });
      await feedback.feedbackComments.createAsEndUser(scope, authored.id, 'other-user-42', 'Me too');
      const result = await pages.postPage('acme', 'ideas', authored.number);
      const board = await pages.boardPage('acme', 'ideas');
      expect(result.kind).toBe('page');
      const hidden = [NOTE, operatorId, EMAIL, 'other-user-42', scope.workspaceId, scope.projectId, boardId];
      const pageText = `${JSON.stringify(result)}\n${JSON.stringify(board)}`;
      expect(hidden.filter(value => pageText.includes(value))).toEqual([]);
      expect(result.kind === 'page' && result.page.comments.map(comment => comment.body)).toEqual([
        'Planned for next month',
        'Me too',
      ]);
      expect(result.kind === 'page' && Object.keys(result.page.post).toSorted(byText)).toEqual(
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
        ].toSorted(byText),
      );
    });
  });

  describe('routes', () => {
    it('reads a board by the site, and another site is not there', async () => {
      const ok = await call('GET', '/acme/feedback/boards/ideas');
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ board: { slug: 'ideas', name: 'Ideas' } });
      expect(ok.headers.get('cache-control')).toBe('no-store');
      const missing = await call('GET', '/nope/feedback/boards/ideas');
      const invalid = await call('GET', '/NOT_A_SLUG/feedback/boards/ideas');
      expect([missing.status, invalid.status]).toEqual([404, 404]);
    });

    it('votes with a token the app signed and answers the new count', async () => {
      const { id } = await post('Dark mode');
      const token = await tokenFor(secret, 'user-1');
      const voted = await call('POST', `/acme/feedback/posts/${id}/vote`, { token, body: { source: 'web' } });
      expect(voted.status).toBe(200);
      expect(voted.body).toEqual({ vote: 'counted', voteCount: 1 });
      const read = await call('GET', `/acme/feedback/posts/${id}`, { token });
      expect(read.body).toMatchObject({ post: { voteCount: 1 }, viewer: { vote: 'counted' } });
      const unvoted = await call('DELETE', `/acme/feedback/posts/${id}/vote`, { token });
      expect(unvoted.body).toEqual({ vote: null, voteCount: 0 });
    });

    it('refuses a write without a token, and a post of another project', async () => {
      const { id } = await post('Dark mode');
      const anonymous = await call('POST', `/acme/feedback/posts/${id}/vote`);
      expect(anonymous.status).toBe(401);
      const { projects } = createProjectDomain(t.db);
      const other = await projects.create(scope.workspaceId, { name: 'Other', handle: 'other' });
      const otherScope = { workspaceId: scope.workspaceId, projectId: other.id };
      const otherBoard = await feedback.feedbackBoards.createBoard(otherScope, operatorId, {
        slug: 'ideas',
        name: 'Ideas',
      });
      const foreign = await feedback.feedbackPosts.create(otherScope, operatorId, {
        boardId: otherBoard.id,
        title: 'Theirs',
      });
      const read = await call('GET', `/acme/feedback/posts/${foreign.id}`);
      expect(read.status).toBe(404);
    });

    it('posts as the signed-in end user, and comments never name anyone', async () => {
      const token = await tokenFor(secret, 'user-1');
      const created = await call('POST', '/acme/feedback/boards/ideas/posts', {
        token,
        body: { title: 'Export to CSV', source: 'web' },
      });
      expect(created.status).toBe(201);
      const postId = (created.body.post as Json).id as string;
      expect(created.body.post).toMatchObject({ status: 'under_review', voteCount: 1 });
      await feedback.feedbackComments.createAsStaff(scope, operatorId, postId, {
        body: NOTE,
        isOfficial: false,
        isInternal: true,
      });
      const commented = await call('POST', `/acme/feedback/posts/${postId}/comments`, {
        token,
        body: { body: 'Please' },
      });
      expect(commented.status).toBe(201);
      const listed = await call('GET', `/acme/feedback/posts/${postId}/comments`, { token });
      expect(listed.body.comments).toEqual([expect.objectContaining({ body: 'Please', isMine: true })]);
      const answers = `${created.text}\n${commented.text}\n${listed.text}`;
      expect(['user-1', EMAIL, NOTE].filter(value => answers.includes(value))).toEqual([]);
    });
  });
});
