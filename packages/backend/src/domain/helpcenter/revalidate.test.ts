import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { checkRevalidateRequest, helpPagePaths } from '@backend/domain/helpcenter/revalidate';
import { HttpHelpRevalidator } from '@backend/domain/helpcenter/revalidate-http';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { Translator } from '@backend/domain/helpcenter/translate/Translator';

describe('helpPagePaths', () => {
  it('lists the home in every language, and the article in every language', () => {
    const site = { slug: 'syt', sourceLocale: 'ko', locales: ['en'] };

    expect(helpPagePaths(site)).toEqual(['/_sites/syt', '/_sites/syt/ko', '/_sites/syt/en']);
    expect(helpPagePaths(site, { shortId: 'abc123', slug: 'widget' }).slice(3)).toEqual([
      '/_sites/syt/ko/articles/abc123-widget',
      '/_sites/syt/en/articles/abc123-widget',
    ]);
  });
});

describe('checkRevalidateRequest', () => {
  const body = { paths: ['/_sites/syt/ko'] };

  it('needs a configured secret, the right bearer, and help site paths', () => {
    expect(checkRevalidateRequest('Bearer s3cret', body, [])).toEqual({ status: 503, paths: [] });
    expect(checkRevalidateRequest(undefined, body, ['s3cret'])).toEqual({ status: 401, paths: [] });
    expect(checkRevalidateRequest('Bearer wrong', body, ['s3cret'])).toEqual({ status: 401, paths: [] });
    expect(checkRevalidateRequest('Bearer s3cret', { paths: ['/workspaces/x'] }, ['s3cret'])).toEqual({
      status: 400,
      paths: [],
    });
    expect(checkRevalidateRequest('Bearer s3cret', { paths: ['/_sites/../x'] }, ['s3cret'])).toEqual({
      status: 400,
      paths: [],
    });
    expect(checkRevalidateRequest('Bearer s3cret', body, ['other', 's3cret'])).toEqual({ status: 200, ...body });
  });
});

describe('HttpHelpRevalidator', () => {
  it('posts the paths with the secret, and throws on a refusal', async () => {
    const fetchSpy = vi.fn(async () => await Promise.resolve(Response.json({ revalidated: 1 })));
    const revalidator = new HttpHelpRevalidator({ origin: 'https://mocco.test', secret: 's3cret', fetch: fetchSpy });

    await revalidator.revalidate(['/_sites/syt/ko']);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mocco.test/api/help/revalidate');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer s3cret');
    expect(JSON.parse(init.body as string)).toEqual({ paths: ['/_sites/syt/ko'] });

    const refusing = new HttpHelpRevalidator({
      origin: 'https://mocco.test',
      secret: 's3cret',
      fetch: async () => await Promise.resolve(new Response('', { status: 401 })),
    });
    await expect(refusing.revalidate(['/_sites/syt'])).rejects.toThrow('401');
  });
});

describe('refreshing public pages on change (pglite)', () => {
  let t: TestDb;
  let workspaceId: string;
  let projectId: string;
  let authorId: string;

  beforeEach(async () => {
    t = await createTestDb();
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    authorId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'SYT', handle: 'syt' });
    projectId = project.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('refreshes the article on publish, translation, unpublish and delete; a failing refresh is ignored', async () => {
    const calls: string[][] = [];
    let isDown = false;
    const translator: Translator = {
      name: 'fake',
      translate: async ({ title, body }) => await Promise.resolve({ title: `EN ${title}`, body }),
    };
    const help = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      translator,
      revalidator: {
        revalidate: async paths => {
          if (isDown) {
            throw new Error('down');
          }
          calls.push([...paths]);
          await Promise.resolve();
        },
      },
    });
    await help.helpSites.enable(workspaceId, projectId, authorId, { slug: 'syt', sourceLocale: 'ko', locales: ['en'] });
    const collection = await help.helpAuthoring.createCollection(workspaceId, projectId, {
      title: '시작',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, projectId, {
      collectionId: collection.id,
      title: '기본',
    });
    const article = await help.helpAuthoring.createArticle(workspaceId, projectId, authorId, {
      sectionId: section.id,
      title: '위젯',
      slug: 'widget',
    });
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, {
      articleId: article.id,
      title: '위젯',
      body: '길게 누르세요.',
    });
    const articlePage = `/_sites/syt/en/articles/${article.shortId}-widget`;

    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
    await help.helpTranslations.translateArticle({ workspaceId, articleId: article.id, locale: 'en' });
    await help.helpAuthoring.unpublish(workspaceId, projectId, authorId, article.id);
    isDown = true;
    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
    isDown = false;
    await help.helpAuthoring.deleteArticle(workspaceId, projectId, authorId, article.id);

    expect(calls).toHaveLength(4);
    expect(calls.every(paths => paths.includes(articlePage) && paths.includes('/_sites/syt/ko'))).toBe(true);
  });
});
