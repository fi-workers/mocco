// /v1/feedback, second slice (#174), end to end on pglite: end users' posts, the similar-posts
// search, following a post, voting by email (a pending vote, the mail through the log sink, the
// signed link that counts it) and the signed one-click unsubscribe link, with their limits.
import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { FeedbackPostStatuses, FeedbackVoteSources, FeedbackVoteStates } from '@mocco/common/feedback';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { EndUserTokenService } from '@backend/domain/enduser/EndUserTokenService';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { emailEndUserIdOf, PENDING_VOTE_TTL_MS } from '@backend/domain/feedback/EmailVoteService';
import { FeedbackLinkPurposes, FeedbackLinkTokens } from '@backend/domain/feedback/link-tokens';
import { FeedbackVoteRepo } from '@backend/domain/feedback/repos/vote.repo';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { LogEmailSender } from '@backend/domain/notification/senders/email';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { feedbackVotes, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { FeedbackRateLimits } from '@backend/transport/ext/v1/feedback';
import { FeedbackLinkRateLimits } from '@backend/transport/ext/v1/feedback-links';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { V1Env } from '@backend/transport/ext/v1/middleware';

const ORIGIN = 'https://www.mocco.test';
const BASE = `${ORIGIN}/api/ext/v1/feedback`;
const START = new Date('2026-10-06T12:00:30Z');
const EMAIL = 'Grace.Hopper@Example.com';
const LINK_KEY = 'test-feedback-link-key';

type Json = Record<string, unknown>;

/** Run `step` `n` times one after another; the statuses in order. */
const repeat = async (n: number, step: (index: number) => Promise<number>): Promise<number[]> =>
  await Array.from({ length: n }).reduce<Promise<number[]>>(async (previous, _, index) => {
    const done = await previous;
    return [...done, await step(index)];
  }, Promise.resolve([]));

describe('/v1/feedback posts, subscriptions and email votes (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let operatorId: string;
  let secret: string;
  let key: string;
  let boardId: string;
  let now: Date;
  let mailLog: string[];

  const nowSeconds = () => Math.floor(now.getTime() / 1000);
  const tokenFor = async (sub: string) =>
    await new SignJWT({ email: 'someone@their-app.test' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setExpirationTime(nowSeconds() + 600)
      .sign(new TextEncoder().encode(secret));

  const call = async (
    method: string,
    url: string,
    opts: { key?: string; token?: string; body?: unknown; ip?: string } = {},
  ) => {
    const response = await app.fetch(
      // eslint-disable-next-line sonarjs/null-dereference -- url is a string, never null
      new Request(url.startsWith('https://') ? url : `${BASE}${url}`, {
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
    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    return { status: response.status, headers: response.headers, text, body: isJson ? (JSON.parse(text) as Json) : {} };
  };
  const statusOf = async (...args: Parameters<typeof call>) => {
    const answer = await call(...args);
    return answer.status;
  };
  const post = async (title: string, body = '') => {
    const created = await feedback.feedbackPosts.create(scope, operatorId, { boardId, title, body });
    return created.id;
  };
  const voteCountOf = async (postId: string) => {
    const row = await feedback.feedbackPosts.requirePost(scope, postId);
    return row.voteCount;
  };
  /** The confirmation and unsubscribe links of the last mail the log sink printed. */
  const linksOfLastMail = () => {
    const mail = mailLog.at(-1) ?? '';
    const confirm = /Confirm: (\S+)/u.exec(mail)?.[1] ?? '';
    const unsubscribe = /List-Unsubscribe: <(\S+)>/u.exec(mail)?.[1] ?? '';
    return { mail, confirm, unsubscribe };
  };
  const build = (opts: { links?: boolean; email?: boolean } = {}) => {
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    feedback = createFeedbackDomain(t.db, {
      audit,
      now: () => now,
      ...(opts.links !== false && {
        links: {
          tokens: new FeedbackLinkTokens(LINK_KEY),
          email:
            opts.email === false
              ? undefined
              : new LogEmailSender(line => {
                  mailLog.push(line);
                }),
          appOrigin: ORIGIN,
        },
      }),
    });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    const messenger = createMessengerDomain(t.db, { audit, box: () => box, appOrigin: ORIGIN });
    const { projects } = createProjectDomain(t.db);
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys: createApiKeyService(t.db, { projects, audit }),
        limiter: new MemoryRateLimiter(() => START),
        feedback: {
          boards: feedback.feedbackPublic,
          endUsers: new EndUserTokenService({ secrets: messenger.messengerSettings, now: () => now }),
          emailVotes: feedback.feedbackEmailVotes,
        },
      }),
    );
    return { messenger, projects, audit };
  };

  beforeEach(async () => {
    t = await createTestDb();
    now = START;
    mailLog = [];
    const { messenger, projects, audit } = build();
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    operatorId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
    ({ identitySecret: secret } = await messenger.messengerSettings.enable(workspaceId, project.id, operatorId));
    const created = await createApiKeyService(t.db, { projects, audit }).create(workspaceId, project.id, operatorId, {
      kind: ApiKeyKinds.publishable,
      name: 'app',
      scopes: [ApiScopes.feedbackRead, ApiScopes.feedbackWrite],
      expiresAt: null,
      flagEnvironmentId: null,
    });
    key = created.token;
    ({ id: boardId } = await feedback.feedbackBoards.createBoard(scope, operatorId, { slug: 'ideas', name: 'Ideas' }));
  });
  afterEach(async () => {
    await t.close();
  });

  describe('posting', () => {
    it("posts under review with the author's vote, and never serves who wrote it", async () => {
      expect(await statusOf('POST', '/boards/ideas/posts', { key, body: { title: 'Dark mode' } })).toBe(401);
      const token = await tokenFor('app-user-7');
      const created = await call('POST', '/boards/ideas/posts', {
        key,
        token,
        body: { title: '  Dark mode  ', body: 'Please' },
      });
      expect(created.status).toBe(201);
      expect(created.body.post).toMatchObject({
        title: 'Dark mode',
        body: 'Please',
        status: FeedbackPostStatuses.underReview,
        voteCount: 1,
        number: 1,
      });
      expect(created.text).not.toContain('app-user-7');
      expect(created.text).not.toMatch(/author/u);
      const id = (created.body.post as Json).id as string;
      const row = await feedback.feedbackPosts.requirePost(scope, id);
      expect(row).toMatchObject({ authorEndUserId: 'app-user-7', authorUserId: null });
      const detail = await call('GET', `/posts/${id}`, { key, token });
      expect(detail.body.viewer).toEqual({ vote: FeedbackVoteStates.counted });
      const followers = await feedback.feedbackSubscriptions.list(scope, id, { limit: 10, offset: 0 });
      expect(followers.map(follower => follower.endUserId)).toEqual(['app-user-7']);
      const { history } = await feedback.feedbackPosts.get(scope, id);
      expect(history).toMatchObject([
        { fromStatus: null, toStatus: FeedbackPostStatuses.underReview, actorUserId: null },
      ]);
    });

    it("refuses a private board, another board's category and an empty title", async () => {
      const token = await tokenFor('u1');
      const hidden = await feedback.feedbackBoards.createBoard(scope, operatorId, {
        slug: 'hidden',
        name: 'Hidden',
        isPublic: false,
      });
      const elsewhere = await feedback.feedbackBoards.createCategory(scope, hidden.id, { slug: 'x', name: 'X' });
      expect(await statusOf('POST', '/boards/hidden/posts', { key, token, body: { title: 'A' } })).toBe(404);
      expect(
        await statusOf('POST', '/boards/ideas/posts', { key, token, body: { title: 'A', categoryId: elsewhere.id } }),
      ).toBe(404);
      expect(await statusOf('POST', '/boards/ideas/posts', { key, token, body: { title: ' ' } })).toBe(400);
    });

    it('limits posts per end user', async () => {
      const token = await tokenFor('prolific');
      const statuses = await repeat(
        FeedbackRateLimits.posts.limit,
        async index => await statusOf('POST', '/boards/ideas/posts', { key, token, body: { title: `Idea ${index}` } }),
      );
      expect(statuses.every(status => status === 201)).toBe(true);
      expect(await statusOf('POST', '/boards/ideas/posts', { key, token, body: { title: 'One more' } })).toBe(429);
    });
  });

  describe('similar posts', () => {
    it('ranks title words over body words, leaves out merged duplicates, and matches literally', async () => {
      const titled = await post('Dark mode for the editor');
      const bodied = await post('Theme options', 'a dark palette would be nice');
      const duplicate = await post('Dark mode please');
      await post('Unrelated');
      await feedback.feedbackMerges.merge(scope, operatorId, duplicate, titled);
      const similar = await call('GET', `/boards/ideas/similar?q=${encodeURIComponent('dark MODE')}`, { key });
      expect(similar.status).toBe(200);
      expect((similar.body.posts as Json[]).map(row => row.id)).toEqual([titled, bodied]);
      const wildcard = await call('GET', `/boards/ideas/similar?q=${encodeURIComponent('%%')}`, { key });
      expect(wildcard.body.posts).toEqual([]);
      expect(await statusOf('GET', '/boards/ideas/similar', { key })).toBe(400);
      expect(await statusOf('GET', '/boards/nope/similar?q=dark', { key })).toBe(404);
    });

    it('limits searches per client address', async () => {
      const statuses = await repeat(
        FeedbackRateLimits.similar.limit,
        async () => await statusOf('GET', '/boards/ideas/similar?q=dark', { key, ip: '198.51.100.1' }),
      );
      expect(statuses.every(status => status === 200)).toBe(true);
      expect(await statusOf('GET', '/boards/ideas/similar?q=dark', { key, ip: '198.51.100.1' })).toBe(429);
      expect(await statusOf('GET', '/boards/ideas/similar?q=dark', { key, ip: '198.51.100.2' })).toBe(200);
    });
  });

  describe('subscriptions', () => {
    it('follows and stops following, and an opt-out outlives a later vote', async () => {
      const id = await post('Dark mode');
      const token = await tokenFor('u1');
      expect(await statusOf('POST', `/posts/${id}/subscription`, { key })).toBe(401);
      const followed = await call('POST', `/posts/${id}/subscription`, { key, token });
      expect(followed.body).toEqual({ subscribed: true });
      const unfollowed = await call('DELETE', `/posts/${id}/subscription`, { key, token });
      expect(unfollowed.body).toEqual({ subscribed: false });
      await call('POST', `/posts/${id}/vote`, { key, token });
      const followers = await feedback.feedbackSubscriptions.list(scope, id, { limit: 10, offset: 0 });
      expect(followers).toEqual([]);
      const merged = await post('Dupe');
      await feedback.feedbackMerges.merge(scope, operatorId, merged, id);
      expect(await statusOf('POST', `/posts/${merged}/subscription`, { key, token })).toBe(409);
    });
  });

  describe('voting by email', () => {
    it('records a pending vote, mails a link through the log sink, and counts the vote when it is opened', async () => {
      const id = await post('Dark mode');
      const started = await call('POST', '/identify/email', { key, body: { email: EMAIL, postId: id } });
      expect(started.status).toBe(202);
      expect(started.body).toEqual({ status: 'pending_confirmation' });
      expect(started.text).not.toContain(EMAIL);
      expect(await voteCountOf(id)).toBe(0);

      const { mail, confirm, unsubscribe } = linksOfLastMail();
      expect(mail).toContain('[email:log] not sent');
      expect(mail).toContain(`To: ${EMAIL}`);
      expect(mail).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
      expect(confirm.startsWith(`${BASE}/identify/email/confirm?token=`)).toBe(true);
      expect(unsubscribe.startsWith(`${BASE}/unsubscribe/`)).toBe(true);

      const page = await call('GET', confirm);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.text).toContain('your vote counts now');
      expect(await voteCountOf(id)).toBe(1);
      const vote = await new FeedbackVoteRepo(t.db).find(scope.workspaceId, id, emailEndUserIdOf(EMAIL));
      expect(vote?.state).toBe(FeedbackVoteStates.counted);
      // Opening it again changes nothing.
      expect(await statusOf('GET', confirm)).toBe(200);
      expect(await voteCountOf(id)).toBe(1);
    });

    it('counts every pending vote of the address from the last week, but not older ones', async () => {
      const old = await post('Old idea');
      const recent = await post('Recent idea');
      await call('POST', '/identify/email', { key, body: { email: EMAIL, postId: old } });
      // The old vote was cast more than a week ago (by the database's clock, which wrote it).
      await t.db
        .update(feedbackVotes)
        .set({ createdAt: sql`now() - make_interval(secs => ${PENDING_VOTE_TTL_MS / 1000 + 60})` })
        .where(eq(feedbackVotes.postId, old));
      await call('POST', '/identify/email', { key, body: { email: EMAIL.toLowerCase(), postId: recent } });
      const { confirm } = linksOfLastMail();
      const page = await call('GET', confirm);
      expect(page.text).toContain('your vote counts now');
      expect(await voteCountOf(recent)).toBe(1);
      expect(await voteCountOf(old)).toBe(0);
    });

    it('refuses an expired, edited or wrong-purpose link with the "not valid" page', async () => {
      const id = await post('Dark mode');
      await call('POST', '/identify/email', { key, body: { email: EMAIL, postId: id } });
      const { confirm, unsubscribe } = linksOfLastMail();
      const edited = confirm.replace(/.$/u, char => (char === 'A' ? 'B' : 'A'));
      expect(await statusOf('GET', edited)).toBe(400);
      const unsubscribeToken = decodeURIComponent(unsubscribe.slice(`${BASE}/unsubscribe/`.length));
      expect(await statusOf('GET', `/identify/email/confirm?token=${encodeURIComponent(unsubscribeToken)}`)).toBe(400);
      now = new Date(START.getTime() + 25 * 60 * 60 * 1000);
      const expired = await call('GET', confirm);
      expect(expired.status).toBe(400);
      expect(expired.text).toContain('isn&#39;t valid');
      expect(await voteCountOf(id)).toBe(0);
    });

    it('limits mails per address and per client address', async () => {
      const id = await post('Dark mode');
      const perEmail = await repeat(
        FeedbackLinkRateLimits.identifyPerEmail.limit,
        async () =>
          await statusOf('POST', '/identify/email', { key, body: { email: EMAIL, postId: id }, ip: '203.0.113.1' }),
      );
      expect(perEmail.every(status => status === 202)).toBe(true);
      expect(
        await statusOf('POST', '/identify/email', { key, body: { email: EMAIL, postId: id }, ip: '203.0.113.2' }),
      ).toBe(429);
      const perClient = await repeat(
        FeedbackLinkRateLimits.identifyPerClient.limit,
        async index =>
          await statusOf('POST', '/identify/email', {
            key,
            body: { email: `voter-${index}@example.com`, postId: id },
            ip: '203.0.113.9',
          }),
      );
      expect(perClient.every(status => status === 202)).toBe(true);
      expect(
        await statusOf('POST', '/identify/email', {
          key,
          body: { email: 'one-more@example.com', postId: id },
          ip: '203.0.113.9',
        }),
      ).toBe(429);
    });

    it('refuses a signed token that claims an email voter id, and a bad address or post', async () => {
      const id = await post('Dark mode');
      const claimed = await call('POST', `/posts/${id}/vote`, { key, token: await tokenFor(emailEndUserIdOf(EMAIL)) });
      expect(claimed.status).toBe(401);
      expect(await statusOf('POST', '/identify/email', { key, body: { email: 'not-an-address', postId: id } })).toBe(
        400,
      );
      expect(await statusOf('POST', '/identify/email', { key, body: { email: EMAIL, postId: randomUUID() } })).toBe(
        404,
      );
      expect(await statusOf('POST', '/identify/email', { body: { email: EMAIL, postId: id } })).toBe(401);
    });

    it('answers 503 when the server sends no email or signs no links', async () => {
      const id = await post('Dark mode');
      build({ email: false });
      const noMail = await call('POST', '/identify/email', { key, body: { email: EMAIL, postId: id } });
      expect(noMail.status).toBe(503);
      expect(noMail.body.type).toBe('https://mocco.dev/problems/email_unavailable');
      build({ links: false });
      expect(await statusOf('POST', '/identify/email', { key, body: { email: EMAIL, postId: id } })).toBe(503);
      expect(await statusOf('GET', '/identify/email/confirm?token=x')).toBe(400);
      expect(await voteCountOf(id)).toBe(0);
    });
  });

  describe('unsubscribe links', () => {
    it('asks on GET, so a mail scanner unsubscribes nobody, and unsubscribes on POST', async () => {
      const id = await post('Dark mode <b>now</b>');
      await call('POST', '/identify/email', { key, body: { email: EMAIL, postId: id } });
      const { unsubscribe } = linksOfLastMail();
      const voter = emailEndUserIdOf(EMAIL);
      const followers = async () => {
        const rows = await feedback.feedbackSubscriptions.list(scope, id, { limit: 10, offset: 0 });
        return rows.map(row => row.endUserId);
      };
      expect(await followers()).toEqual([voter]);

      const ask = await call('GET', unsubscribe);
      expect(ask.status).toBe(200);
      expect(ask.text).toContain('<form method="post"');
      expect(ask.text).toContain('Dark mode &lt;b&gt;now&lt;/b&gt;');
      expect(ask.text).not.toContain(EMAIL);
      expect(await followers()).toEqual([voter]);

      const done = await call('POST', unsubscribe);
      expect(done.status).toBe(200);
      expect(done.text).toContain('won&#39;t get mail');
      expect(await followers()).toEqual([]);
      // One-click again is a no-op, and a later vote doesn't resubscribe.
      expect(await statusOf('POST', unsubscribe)).toBe(200);
    });

    it('refuses an edited or wrong-purpose token, and follows a merge to the post that took the subscribers', async () => {
      const source = await post('Dupe');
      const target = await post('Original');
      const tokens = new FeedbackLinkTokens(LINK_KEY);
      const voter = 'app-user-1';
      await feedback.feedbackVotes.vote(scope, source, voter, { source: FeedbackVoteSources.web });
      const identifyToken = tokens.issue(FeedbackLinkPurposes.identify, { ...scope, endUserId: voter }, now);
      expect(await statusOf('POST', `/unsubscribe/${encodeURIComponent(identifyToken)}`)).toBe(400);
      const token = tokens.issue(FeedbackLinkPurposes.unsubscribe, { ...scope, endUserId: voter, postId: source }, now);
      const edited = encodeURIComponent(`${token}x`);
      expect(await statusOf('POST', `/unsubscribe/${edited}`)).toBe(400);
      const forged = new FeedbackLinkTokens('another-key').issue(
        FeedbackLinkPurposes.unsubscribe,
        { ...scope, endUserId: voter, postId: source },
        now,
      );
      expect(await statusOf('POST', `/unsubscribe/${encodeURIComponent(forged)}`)).toBe(400);

      await feedback.feedbackMerges.merge(scope, operatorId, source, target);
      expect(await statusOf('POST', `/unsubscribe/${encodeURIComponent(token)}`)).toBe(200);
      const followers = await feedback.feedbackSubscriptions.list(scope, target, { limit: 10, offset: 0 });
      expect(followers).toEqual([]);
    });

    it('limits link openings per client address', async () => {
      const statuses = await repeat(
        FeedbackLinkRateLimits.links.limit,
        async () => await statusOf('GET', '/unsubscribe/nope', { ip: '192.0.2.4' }),
      );
      expect(statuses.every(status => status === 400)).toBe(true);
      expect(await statusOf('GET', '/unsubscribe/nope', { ip: '192.0.2.4' })).toBe(429);
    });
  });
});
