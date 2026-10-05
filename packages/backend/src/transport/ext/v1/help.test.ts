import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { AppPlatforms } from '@mocco/common/project';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { HELP_FEEDBACK_RATE_LIMIT } from '@backend/domain/helpcenter/HelpFeedbackService';
import { helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { expectOne } from '@backend/infra/db/rows';
import { helpFeedback, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';
import type { RateLimiter } from '@backend/domain/ratelimit/ports';
import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ApiScope } from '@mocco/common/apikey';

const BASE = 'https://www.mocco.test/api/ext/v1/help';
/** Requests a key may make a minute in these tests (the real limit is 600). */
const TEST_KEY_LIMIT = 40;

describe('/v1/help (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let help: HelpDomain;
  let clock: Date;
  let projects: ReturnType<typeof createProjectDomain>['projects'];
  let workspaceId: string;
  let userId: string;
  let projectId: string;
  let otherProjectId: string;
  let keyFor: (scopes: ApiScope[], project?: string) => Promise<string>;

  const get = async (key: string | undefined, path: string, headers: Record<string, string> = {}) => {
    const response = await app.fetch(
      new Request(`${BASE}${path}`, {
        headers: { ...(key !== undefined && { authorization: `Bearer ${key}` }), ...headers },
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      etag: response.headers.get('etag'),
      body: (text === '' ? undefined : JSON.parse(text)) as Record<string, unknown> | undefined,
    };
  };

  const answer = async (key: string | undefined, ref: string, body: unknown, headers?: Record<string, string>) => {
    const response = await app.fetch(
      new Request(`${BASE}/articles/${ref}/feedback`, {
        method: 'POST',
        headers: {
          ...(key !== undefined && { authorization: `Bearer ${key}` }),
          'content-type': 'application/json',
          ...(headers ?? { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Phone/1' }),
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  /** A published article (and a draft-only and an unpublished one) in `project`'s help center. */
  const publish = async (inProject = projectId, slug = 'syt') => {
    await help.helpSites.enable(workspaceId, inProject, userId, { slug, sourceLocale: 'ko', locales: ['en', 'ja'] });
    const collection = await help.helpAuthoring.createCollection(workspaceId, inProject, {
      title: '시작',
      slug: 'start',
      description: '처음 쓰는 분께',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, inProject, {
      collectionId: collection.id,
      title: '기본',
    });
    const write = async (title: string, articleSlug: string, body: string) => {
      const article = await help.helpAuthoring.createArticle(workspaceId, inProject, userId, {
        sectionId: section.id,
        title,
        slug: articleSlug,
      });
      await help.helpAuthoring.saveDraft(workspaceId, inProject, userId, { articleId: article.id, title, body });
      return article;
    };
    const widget = await write('위젯 추가하기', 'widget', '홈 화면을 길게 누르세요.');
    await help.helpAuthoring.publish(workspaceId, inProject, userId, widget.id);
    const draft = await write('준비 중', 'draft', '아직 공개 전');
    const pulled = await write('예전 글', 'old', '내렸어요');
    await help.helpAuthoring.publish(workspaceId, inProject, userId, pulled.id);
    await help.helpAuthoring.unpublish(workspaceId, inProject, userId, pulled.id);
    return { widget, draft, pulled };
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    clock = new Date('2026-10-05T10:00:00Z');
    help = createHelpDomain(t.db, { audit, feedbackSecret: () => 'test-feedback-secret', now: () => clock });
    ({ projects } = createProjectDomain(t.db));
    const apiKeys = createApiKeyService(t.db, { projects, audit });
    const memory = new MemoryRateLimiter(() => new Date('2026-10-02T10:00:30Z'));
    // The real limiter and rules, with a key's limit scaled down so a test can use it up.
    const limiter: RateLimiter = {
      consume: async (bucket, rule) =>
        // eslint-disable-next-line sonarjs/null-dereference -- the limiter always passes a bucket name
        await memory.consume(bucket, bucket.startsWith('key:') ? { ...rule, limit: TEST_KEY_LIMIT } : rule),
    };
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys,
        limiter,
        help: {
          help: help.helpPublic,
          feedback: help.helpFeedback,
          originOf: slug => helpSiteOrigin(slug, { HELP_CUSTOM_DOMAINS: 'help.showyourti.me=syt' }),
        },
      }),
    );
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const syt = await projects.create(workspaceId, { name: 'ShowYourTime', handle: 'syt' });
    const otherProject = await projects.create(workspaceId, { name: 'Other', handle: 'other' });
    projectId = syt.id;
    otherProjectId = otherProject.id;
    keyFor = async (scopes, project = projectId) => {
      const created = await apiKeys.create(workspaceId, project, userId, {
        kind: ApiKeyKinds.publishable,
        name: 'app',
        scopes,
        expiresAt: null,
        flagEnvironmentId: null,
      });
      return created.token;
    };
  });
  afterEach(async () => {
    await t.close();
  });

  describe('search', () => {
    it('searches the key’s help center with a publishable key, with absolute article URLs', async () => {
      const { widget } = await publish();
      const key = await keyFor([ApiScopes.helpRead]);

      // A device's language tag carries a region; its language is what counts.
      const found = await get(key, '/search?q=%EC%9C%84%EC%A0%AF&locale=en-KR');

      expect([found.status, found.body]).toEqual([
        200,
        {
          locale: 'en',
          hits: [
            {
              title: '위젯 추가하기',
              path: `/ko/articles/${widget.shortId}-widget`,
              url: `https://help.showyourti.me/ko/articles/${widget.shortId}-widget`,
              snippet: '홈 화면을 길게 누르세요.',
            },
          ],
        },
      ]);
    });

    it('matches any word of free text with match=any', async () => {
      await publish();
      const key = await keyFor([ApiScopes.helpRead]);
      const query = `q=${encodeURIComponent('위젯이 화면에 안 보여요')}`;

      const every = await get(key, `/search?${query}`);
      const any = await get(key, `/search?${query}&match=any`);

      expect([every.body, any.status]).toEqual([{ locale: 'ko', hits: [] }, 200]);
      expect((any.body as { hits: { title: string }[] }).hits.map(hit => hit.title)).toEqual(['위젯 추가하기']);
    });

    it('needs help:read, a query, and a help center', async () => {
      const withoutScope = await keyFor([ApiScopes.messengerChat]);
      const key = await keyFor([ApiScopes.helpRead]);

      const noSite = await get(key, '/search?q=x');
      await publish();
      const noScope = await get(withoutScope, '/search?q=x');
      const noQuery = await get(key, '/search?q=');

      expect([noSite.status, noScope.status, noQuery.status]).toEqual([404, 403, 400]);
    });
  });

  describe('site and collections', () => {
    it('lists the published tree in the asked language, falling back to the source', async () => {
      const { widget } = await publish();
      await help.helpTranslations.saveTranslation(workspaceId, projectId, userId, {
        articleId: widget.id,
        locale: 'en',
        title: 'Add a widget',
        body: 'Long-press the home screen.',
      });
      const key = await keyFor([ApiScopes.helpRead]);

      const english = await get(key, '/site?locale=en-US');
      // French isn't offered, and Japanese has no translation yet: both serve the source text.
      const french = await get(key, '/site?locale=fr');
      const japanese = await get(key, '/site?locale=ja');

      expect([english.status, english.body]).toEqual([
        200,
        {
          name: 'ShowYourTime',
          sourceLocale: 'ko',
          locales: ['en', 'ja'],
          locale: 'en',
          url: 'https://help.showyourti.me/en',
          collections: [
            {
              slug: 'start',
              title: '시작',
              description: '처음 쓰는 분께',
              sections: [
                {
                  title: '기본',
                  articles: [
                    {
                      id: widget.shortId,
                      slug: 'widget',
                      title: 'Add a widget',
                      path: `/en/articles/${widget.shortId}-widget`,
                      url: `https://help.showyourti.me/en/articles/${widget.shortId}-widget`,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);
      expect(french.body).toMatchObject({ locale: 'ko', url: 'https://help.showyourti.me/ko' });
      expect(japanese.body).toMatchObject({
        locale: 'ja',
        collections: [
          { sections: [{ articles: [{ title: '위젯 추가하기', path: `/ko/articles/${widget.shortId}-widget` }] }] },
        ],
      });
    });

    it('shows one collection, and 404s an unknown one', async () => {
      await publish();
      const key = await keyFor([ApiScopes.helpRead]);

      const start = await get(key, '/collections/start?locale=ko');
      const unknown = await get(key, '/collections/nope');

      expect(start.body).toMatchObject({ locale: 'ko', collection: { slug: 'start', sections: [{ title: '기본' }] } });
      expect(unknown.status).toBe(404);
    });

    it('answers 304 for the ETag the caller holds, and a new tag once something is published', async () => {
      const { draft } = await publish();
      const key = await keyFor([ApiScopes.helpRead]);

      const first = await get(key, '/site');
      const again = await get(key, '/site', { 'if-none-match': first.etag ?? '' });
      await help.helpAuthoring.publish(workspaceId, projectId, userId, draft.id);
      const changed = await get(key, '/site', { 'if-none-match': first.etag ?? '' });

      expect(first.etag).toMatch(/^W\/"[\w-]+"$/u);
      expect([again.status, again.body]).toEqual([304, undefined]);
      expect(changed.status).toBe(200);
      expect(changed.etag).not.toBe(first.etag);
    });
  });

  describe('articles', () => {
    it('shows a published article by its id or path ref, saying which language it is in', async () => {
      const { widget } = await publish();
      await help.helpTranslations.saveTranslation(workspaceId, projectId, userId, {
        articleId: widget.id,
        locale: 'en',
        title: 'Add a widget',
        body: 'Long-press the home screen.',
      });
      const key = await keyFor([ApiScopes.helpRead]);

      const english = await get(key, `/articles/${widget.shortId}?locale=en-GB`);
      // A stale slug still finds the article; an untranslated language serves the source.
      const japanese = await get(key, `/articles/${widget.shortId}-old-slug?locale=ja`);

      expect([english.status, english.body]).toEqual([
        200,
        {
          id: widget.shortId,
          slug: 'widget',
          locale: 'en',
          title: 'Add a widget',
          body: 'Long-press the home screen.',
          path: `/en/articles/${widget.shortId}-widget`,
          url: `https://help.showyourti.me/en/articles/${widget.shortId}-widget`,
          locales: ['ko', 'en'],
          publishedAt: expect.any(String) as string,
          updatedAt: expect.any(String) as string,
        },
      ]);
      expect(japanese.body).toMatchObject({
        locale: 'ko',
        title: '위젯 추가하기',
        path: `/ko/articles/${widget.shortId}-widget`,
      });
    });

    it('never shows a draft or an unpublished article, and refuses a malformed ref', async () => {
      const { draft, pulled } = await publish();
      const key = await keyFor([ApiScopes.helpRead]);

      const statuses = await Promise.all(
        [`/articles/${draft.shortId}`, `/articles/${pulled.shortId}`, '/articles/NOT_A_REF'].map(async path => {
          const response = await get(key, path);
          return response.status;
        }),
      );
      const site = await get(key, '/site');

      expect(statuses).toEqual([404, 404, 400]);
      expect(JSON.stringify(site.body)).not.toMatch(/준비 중|예전 글/u);
    });
  });

  describe('was this helpful?', () => {
    it('counts one answer per visitor, article and day; a later answer that day replaces the earlier', async () => {
      const { widget } = await publish();
      const key = await keyFor([ApiScopes.helpRead]);

      const first = await answer(key, widget.shortId, { helpful: false, visitorId: 'visitor-aaaa', locale: 'en-US' });
      const changed = await answer(key, widget.shortId, {
        helpful: true,
        visitorId: 'visitor-aaaa',
        comment: ' Clear ',
      });
      const someoneElse = await answer(key, `${widget.shortId}-widget`, { helpful: false, visitorId: 'visitor-bbbb' });
      clock = new Date('2026-10-06T09:00:00Z');
      const nextDay = await answer(key, widget.shortId, { helpful: true, visitorId: 'visitor-aaaa' });

      expect([first, changed, someoneElse, nextDay].map(({ status, body }) => [status, body.counted])).toEqual([
        [201, true],
        [201, false],
        [201, true],
        [201, true],
      ]);
      expect(await help.helpFeedback.helpfulness(workspaceId, projectId, widget.id)).toEqual({
        days: 30,
        helpful: 2,
        notHelpful: 1,
        comments: [{ helpful: true, comment: 'Clear', locale: 'ko', createdAt: new Date('2026-10-05T10:00:00Z') }],
      });
    });

    it('without a visitor id, counts an address and user agent once a day, and stores neither', async () => {
      const { widget } = await publish();
      const key = await keyFor([ApiScopes.helpRead]);
      const phone = { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Phone/1' };

      const once = await answer(key, widget.shortId, { helpful: true }, phone);
      const again = await answer(key, widget.shortId, { helpful: true }, phone);
      const otherDevice = await answer(key, widget.shortId, { helpful: true }, { ...phone, 'user-agent': 'Tablet/2' });
      clock = new Date('2026-10-06T09:00:00Z');
      const tomorrow = await answer(key, widget.shortId, { helpful: true }, phone);
      const stored = await t.db.select().from(helpFeedback);

      expect([once, again, otherDevice, tomorrow].map(({ body }) => body.counted)).toEqual([true, false, true, true]);
      expect(JSON.stringify(stored)).not.toMatch(/203\.0\.113|Phone|Tablet/u);
      expect(stored.map(row => row.locale)).toEqual(['ko', 'ko', 'ko']);
    });

    it('takes answers only on published articles of the key’s project, with help:read', async () => {
      const { widget, draft, pulled } = await publish();
      await publish(otherProjectId, 'other');
      const key = await keyFor([ApiScopes.helpRead]);
      const other = await keyFor([ApiScopes.helpRead], otherProjectId);
      const withoutScope = await keyFor([ApiScopes.messengerChat]);
      const yes = { helpful: true, visitorId: 'visitor-aaaa' };

      const statuses = await Promise.all(
        [
          answer(key, draft.shortId, yes),
          answer(key, pulled.shortId, yes),
          answer(other, widget.shortId, yes),
          answer(undefined, widget.shortId, yes),
          answer(withoutScope, widget.shortId, yes),
          answer(key, widget.shortId, { helpful: 'yes' }),
          answer(key, widget.shortId, { helpful: true, comment: 'x'.repeat(501) }),
        ].map(async pending => {
          const response = await pending;
          return response.status;
        }),
      );

      expect(statuses).toEqual([404, 404, 404, 401, 403, 400, 400]);
      expect(await t.db.select().from(helpFeedback)).toEqual([]);
    });

    it('limits answers per client address', async () => {
      const { widget } = await publish();
      const key = await keyFor([ApiScopes.helpRead]);

      const statuses: number[] = [];
      for (let index = 0; index <= HELP_FEEDBACK_RATE_LIMIT.limit; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential, to count the limit exactly
        const response = await answer(key, widget.shortId, { helpful: true, visitorId: `visitor-${index}-xxxx` });
        statuses.push(response.status);
      }
      const elsewhere = await answer(
        key,
        widget.shortId,
        { helpful: true, visitorId: 'visitor-zzzz' },
        { 'x-forwarded-for': '198.51.100.1' },
      );

      expect([statuses.at(-2), statuses.at(-1), elsewhere.status]).toEqual([201, 429, 201]);
    });
  });

  describe('keys', () => {
    it('refuses no key, a key without help:read, and another project’s key', async () => {
      const { widget } = await publish();
      await publish(otherProjectId, 'other');
      const withoutScope = await keyFor([ApiScopes.messengerChat]);
      const other = await keyFor([ApiScopes.helpRead], otherProjectId);
      const path = `/articles/${widget.shortId}`;

      const none = await get(undefined, path);
      const noScope = await get(withoutScope, path);
      const otherProject = await get(other, path);
      const otherSite = await get(other, '/site');

      expect([none.status, noScope.status, otherProject.status]).toEqual([401, 403, 404]);
      // The other project's key reads its own help center, never this one's.
      expect(otherSite.body).toMatchObject({ name: 'Other', url: null });
    });

    it('limits requests per key', async () => {
      await publish();
      const key = await keyFor([ApiScopes.helpRead]);
      const other = await keyFor([ApiScopes.helpRead]);

      const statuses: number[] = [];
      for (let index = 0; index <= TEST_KEY_LIMIT; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential, to count the limit exactly
        const response = await get(key, '/site');
        statuses.push(response.status);
      }
      const otherKey = await get(other, '/site');

      expect(statuses.filter(status => status === 200)).toHaveLength(TEST_KEY_LIMIT);
      expect([statuses.at(-1), otherKey.status]).toEqual([429, 200]);
    });

    it('answers a browser from one of the project’s web origins, and refuses other origins', async () => {
      await publish();
      const key = await keyFor([ApiScopes.helpRead]);
      await projects.addApp(workspaceId, projectId, {
        platform: AppPlatforms.web,
        name: 'Web',
        webOrigins: ['https://app.showyourti.me'],
      });
      const fromOrigin = async (origin: string) =>
        await app.fetch(new Request(`${BASE}/site`, { headers: { authorization: `Bearer ${key}`, origin } }));

      const allowed = await fromOrigin('https://app.showyourti.me');
      const refused = await fromOrigin('https://evil.test');

      expect([allowed.status, allowed.headers.get('access-control-allow-origin')]).toEqual([
        200,
        'https://app.showyourti.me',
      ]);
      expect(allowed.headers.get('access-control-expose-headers')).toContain('etag');
      expect(refused.status).toBe(403);
    });
  });
});
