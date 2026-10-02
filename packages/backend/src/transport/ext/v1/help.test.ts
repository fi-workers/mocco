import { randomUUID } from 'node:crypto';

import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyService } from '@backend/domain/apikey/instance';
import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { createProjectDomain } from '@backend/domain/project/instance';
import { MemoryRateLimiter } from '@backend/domain/ratelimit/MemoryRateLimiter';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createV1Routes } from '@backend/transport/ext/v1/routes';

import type { V1Env } from '@backend/transport/ext/v1/middleware';
import type { ApiScope } from '@mocco/common/apikey';

const BASE = 'https://www.mocco.test/api/ext/v1/help';

describe('/v1/help (pglite)', () => {
  let t: TestDb;
  let app: Hono<V1Env>;
  let keyFor: (scopes: ApiScope[]) => Promise<string>;
  let publish: () => Promise<string>;

  const search = async (key: string, query: string) => {
    const response = await app.fetch(
      new Request(`${BASE}/search?${query}`, { headers: { authorization: `Bearer ${key}` } }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const help = createHelpDomain(t.db, { audit });
    const { projects } = createProjectDomain(t.db);
    const apiKeys = createApiKeyService(t.db, { projects, audit });
    app = new Hono<V1Env>().basePath('/api/ext').route(
      '/v1',
      createV1Routes({
        apiKeys,
        limiter: new MemoryRateLimiter(() => new Date('2026-10-02T10:00:30Z')),
        help: {
          help: help.helpPublic,
          originOf: slug => helpSiteOrigin(slug, { HELP_CUSTOM_DOMAINS: 'help.showyourti.me=syt' }),
        },
      }),
    );
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await projects.create(workspaceId, { name: 'ShowYourTime', handle: 'syt' });
    keyFor = async scopes => {
      const created = await apiKeys.create(workspaceId, project.id, userId, {
        kind: ApiKeyKinds.publishable,
        name: 'app',
        scopes,
        expiresAt: null,
        flagEnvironmentId: null,
      });
      return created.token;
    };
    publish = async () => {
      await help.helpSites.enable(workspaceId, project.id, userId, {
        slug: 'syt',
        sourceLocale: 'ko',
        locales: ['en'],
      });
      const collection = await help.helpAuthoring.createCollection(workspaceId, project.id, {
        title: '시작',
        slug: 'start',
      });
      const section = await help.helpAuthoring.createSection(workspaceId, project.id, {
        collectionId: collection.id,
        title: '기본',
      });
      const article = await help.helpAuthoring.createArticle(workspaceId, project.id, userId, {
        sectionId: section.id,
        title: '위젯 추가하기',
        slug: 'widget',
      });
      await help.helpAuthoring.saveDraft(workspaceId, project.id, userId, {
        articleId: article.id,
        title: '위젯 추가하기',
        body: '홈 화면을 길게 누르세요.',
      });
      await help.helpAuthoring.publish(workspaceId, project.id, userId, article.id);
      return article.shortId;
    };
  });
  afterEach(async () => {
    await t.close();
  });

  it('searches the key’s help center with a publishable key, with absolute article URLs', async () => {
    const shortId = await publish();
    const key = await keyFor([ApiScopes.helpRead]);

    const found = await search(key, 'q=%EC%9C%84%EC%A0%AF&locale=en');

    expect(found).toEqual({
      status: 200,
      body: {
        locale: 'en',
        hits: [
          {
            title: '위젯 추가하기',
            path: `/ko/articles/${shortId}-widget`,
            url: `https://help.showyourti.me/ko/articles/${shortId}-widget`,
            snippet: '홈 화면을 길게 누르세요.',
          },
        ],
      },
    });
  });

  it('matches any word of free text with match=any', async () => {
    await publish();
    const key = await keyFor([ApiScopes.helpRead]);
    const query = `q=${encodeURIComponent('위젯이 화면에 안 보여요')}`;

    const every = await search(key, query);
    const any = await search(key, `${query}&match=any`);

    expect([every.body, any.status]).toEqual([{ locale: 'ko', hits: [] }, 200]);
    expect((any.body as { hits: { title: string }[] }).hits.map(hit => hit.title)).toEqual(['위젯 추가하기']);
  });

  it('needs help:read, a query, and a help center', async () => {
    const withoutScope = await keyFor([ApiScopes.messengerChat]);
    const key = await keyFor([ApiScopes.helpRead]);

    const noSite = await search(key, 'q=x');
    await publish();
    const noScope = await search(withoutScope, 'q=x');
    const noQuery = await search(key, 'q=');

    expect([noSite.status, noScope.status, noQuery.status]).toEqual([404, 403, 400]);
  });
});
