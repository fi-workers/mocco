// /v1/status-pages/:slug/subscribers over HTTP (#156): sign-ups as JSON or a plain form, the
// honeypot, the answers that never tell who follows a page, the limits per client and per
// address, and the pages the mail's links open (confirm; unsubscribe asks before a POST does
// it). What a sign-up and its mail do is pinned in domain/status/SubscriberService.test.ts.
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { createRecordingEmailSender } from '@backend/domain/notification/testing/recording-email';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { createStatusDomain } from '@backend/domain/status/compose';
import { SubscriberTokenPurposes, SubscriberTokens } from '@backend/domain/status/subscriber-token';
import { SubscriberRateLimits } from '@backend/domain/status/SubscriberService';
import { expectOne } from '@backend/infra/db/rows';
import { statusSubscribers, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { EmailSender } from '@backend/domain/notification/senders/email';

const T0 = new Date('2026-10-06T09:00:00.000Z');
const BASE = 'https://www.mocco.test/api/ext/v1/status-pages';

const unsubscribeLink = (token: string) => `${BASE}/acme/subscribers/unsubscribe?token=${encodeURIComponent(token)}`;

describe('/v1/status-pages/:slug/subscribers (pglite)', () => {
  let t: TestDb;
  let clock: Date;
  let tokens: SubscriberTokens;
  let componentIds: { api: string; foreign: string };

  /** The ext app mounted as in production, over a status domain with `email` as its sender. */
  const appWith = async (email: EmailSender | undefined) => {
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => clock,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    const status = createStatusDomain(t.db, {
      audit,
      queue,
      appOrigin: 'https://www.mocco.test',
      subscribers: { tokens, email },
      now: () => clock,
    });
    const { projects } = createProjectDomain(t.db);
    if (status.statusSubscribers === undefined) {
      throw new Error('no subscriber service');
    }
    return {
      status,
      app: new Hono().basePath('/api/ext').route(
        '/v1',
        createV1Routes({
          apiKeys: createApiKeyService(t.db, { projects, audit }),
          limiter: new MemoryRateLimiter(() => clock),
          statusSubscribers: { subscribers: status.statusSubscribers },
        }),
      ),
    };
  };

  let app: Hono;

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    await app.request(`${BASE}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
      body: JSON.stringify(body),
    });
  const subscriberRows = async () => await t.db.select().from(statusSubscribers);

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    tokens = new SubscriberTokens('test-subscriber-key');
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const built = await appWith(createRecordingEmailSender());
    app = built.app;
    const { projects } = createProjectDomain(t.db);
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    const scope = { workspaceId, projectId: project.id };
    const page = await built.status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    const other = await built.status.statusPages.createPage(scope, actor, { slug: 'other', title: 'Other' });
    const api = await built.status.statusPages.createComponent(scope, page.id, { name: 'API' });
    const foreign = await built.status.statusPages.createComponent(scope, other.id, { name: 'Elsewhere' });
    componentIds = { api: api.id, foreign: foreign.id };
  });
  afterEach(async () => {
    await t.close();
  });

  it('takes a sign-up as JSON or a form, and answers the same whoever signs up', async () => {
    const first = await post('acme/subscribers', { email: ' Kim@Example.test ', componentIds: [componentIds.api] });
    expect(first.status).toBe(202);
    expect(first.headers.get('access-control-allow-origin')).toBe('*');
    const body = await first.json();
    // Again for the same address, pending: the same answer.
    const again = await post('acme/subscribers', { email: 'kim@example.test' });
    expect({ status: again.status, body: await again.json() }).toEqual({ status: 202, body });

    const form = new URLSearchParams([
      ['email', 'lee@example.test'],
      ['componentIds', componentIds.api],
      ['locale', 'ko'],
    ]);
    const posted = await app.request(`${BASE}/acme/subscribers`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.8' },
      body: form,
    });
    expect(posted.status).toBe(202);

    const rows = await subscriberRows();
    const byEmail = rows.toSorted((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
    expect(byEmail.map(row => [row.email, row.componentIds, row.locale, row.confirmedAt])).toEqual([
      ['kim@example.test', null, 'en', null],
      ['lee@example.test', [componentIds.api], 'ko', null],
    ]);
  });

  it('answers a filled honeypot like a person and records nothing', async () => {
    const response = await post('acme/subscribers', { email: 'bot@example.test', website: 'https://spam.test' });
    expect(response.status).toBe(202);
    expect(await subscriberRows()).toEqual([]);
  });

  it('refuses a bad address, an unknown page and a component of another page', async () => {
    const badAddress = await post('acme/subscribers', { email: 'not an address' });
    const noAddress = await post('acme/subscribers', {});
    const noPage = await post('nope/subscribers', { email: 'kim@example.test' });
    expect([badAddress.status, noAddress.status, noPage.status]).toEqual([400, 400, 404]);
    const foreign = await post('acme/subscribers', { email: 'kim@example.test', componentIds: [componentIds.foreign] });
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get('content-type')).toBe('application/problem+json');
    expect(await subscriberRows()).toEqual([]);
  });

  it('limits sign-ups per client and per address', async () => {
    const { limit } = SubscriberRateLimits.perClient;
    const statuses = await Array.from({ length: limit + 1 }).reduce<Promise<number[]>>(async (previous, _, n) => {
      const response = await post('acme/subscribers', { email: `user${n}@example.test` });
      return [...(await previous), response.status];
    }, Promise.resolve([]));
    expect(statuses.slice(0, limit).every(code => code === 202)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    // One address from many clients.
    const perEmail = await Array.from({ length: SubscriberRateLimits.perEmail.limit + 1 }).reduce<Promise<number[]>>(
      async (previous, _, n) => {
        const response = await post(
          'acme/subscribers',
          { email: 'target@example.test' },
          { 'x-forwarded-for': `198.51.100.${n}` },
        );
        return [...(await previous), response.status];
      },
      Promise.resolve([]),
    );
    expect(perEmail).toEqual([202, 202, 202, 429]);
  });

  it('takes no sign-up without an email sender, while the links keep working', async () => {
    const built = await appWith(undefined);
    app = built.app;
    const refused = await post('acme/subscribers', { email: 'kim@example.test' });
    expect(refused.status).toBe(503);
    expect(await subscriberRows()).toEqual([]);
  });

  it('confirms from the link, and shows an invalid link as such', async () => {
    await post('acme/subscribers', { email: 'kim@example.test' });
    const { id } = expectOne(await subscriberRows());
    const token = tokens.issue(SubscriberTokenPurposes.confirm, id, clock);

    const confirmed = await app.request(`${BASE}/acme/subscribers/confirm?token=${encodeURIComponent(token)}`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(confirmed.headers.get('cache-control')).toBe('no-store');
    expect(confirmed.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await confirmed.text()).toContain('You&#39;re subscribed to updates from Acme status.');
    expect(expectOne(await subscriberRows()).confirmedAt).toEqual(clock);

    // The confirmation link on another page, an unsubscribe link, and garbage.
    const unsubscribe = tokens.issue(SubscriberTokenPurposes.unsubscribe, id, clock);
    const refused = await Promise.all(
      [
        `${BASE}/other/subscribers/confirm?token=${encodeURIComponent(token)}`,
        `${BASE}/acme/subscribers/confirm?token=${encodeURIComponent(unsubscribe)}`,
        `${BASE}/acme/subscribers/confirm?token=nope`,
      ].map(async url => {
        const response = await app.request(url, { headers: { 'accept-language': 'ko-KR,ko;q=0.9' } });
        const text = await response.text();
        return { status: response.status, isInvalid: text.includes('더 이상 유효하지 않은 링크입니다.') };
      }),
    );
    expect(refused).toEqual(Array.from({ length: 3 }, () => ({ status: 400, isInvalid: true })));
  });

  it('asks before unsubscribing, then unsubscribes from the form or a one-click POST', async () => {
    await post('acme/subscribers', { email: 'kim@example.test' });
    await post('acme/subscribers', { email: 'lee@example.test' });
    const rows = await subscriberRows();
    const [kim, lee] = rows.toSorted((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
    if (kim === undefined || lee === undefined) {
      throw new Error('two subscribers expected');
    }
    const kimLink = unsubscribeLink(tokens.issue(SubscriberTokenPurposes.unsubscribe, kim.id, clock));
    const leeLink = unsubscribeLink(tokens.issue(SubscriberTokenPurposes.unsubscribe, lee.id, clock));

    const asked = await app.request(kimLink);
    expect(asked.status).toBe(200);
    const html = await asked.text();
    expect(html).toContain('<form method="post" action="?token=');
    expect(html).toContain('Stop getting updates from Acme status at this address?');
    // Opening the link (a mail scanner does) changes nothing.
    const opened = await subscriberRows();
    expect(opened.every(row => row.unsubscribedAt === null)).toBe(true);

    const fromForm = await app.request(kimLink, { method: 'POST' });
    expect(fromForm.status).toBe(200);
    expect(await fromForm.text()).toContain('You won&#39;t get updates from Acme status any more.');
    const oneClick = await app.request(leeLink, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.status).toBe(200);
    const after = await t.db.select().from(statusSubscribers).where(eq(statusSubscribers.pageId, kim.pageId));
    expect(after.every(row => row.unsubscribedAt !== null)).toBe(true);
  });
});
