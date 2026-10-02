import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import {
  HelpNodeNotFoundError,
  HelpSiteExistsError,
  HelpSlugTakenError,
  HelpStorageNotConfiguredError,
} from '@backend/domain/helpcenter/errors';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';

/** A bundle of two articles; the widget's body varies. */
const bundle = (body: string) => ({
  collections: [
    {
      title: '시작하기',
      slug: 'features',
      sections: [
        {
          title: '기본 기능',
          articles: [
            { title: '위젯', slug: 'widget-features', body, fromPath: '/features/widget-features' },
            { title: '카메라', slug: 'camera-features', body: 'Camera', fromPath: '/features/camera-features' },
          ],
        },
      ],
    },
  ],
});

describe('help center (pglite)', () => {
  let t: TestDb;
  let help: HelpDomain;
  let workspaceId: string;
  let projectId: string;
  let authorId: string;

  /** A site with one collection and section, and a draft article in it. */
  const setUp = async () => {
    await help.helpSites.enable(workspaceId, projectId, authorId, {
      slug: 'showyourtime',
      sourceLocale: 'ko',
      locales: ['en'],
    });
    const collection = await help.helpAuthoring.createCollection(workspaceId, projectId, {
      title: '시작하기',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, projectId, {
      collectionId: collection.id,
      title: '기본 기능',
    });
    const article = await help.helpAuthoring.createArticle(workspaceId, projectId, authorId, {
      sectionId: section.id,
      title: 'Widget features',
    });
    return { collection, section, article };
  };

  beforeEach(async () => {
    t = await createTestDb();
    help = createHelpDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }) });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    authorId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, {
      name: 'ShowYourTime',
      handle: 'syt',
    });
    projectId = project.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('gives a project one site, on a slug no other site has', async () => {
    await help.helpSites.enable(workspaceId, projectId, authorId, {
      slug: 'showyourtime',
      sourceLocale: 'ko',
      locales: [],
    });
    const other = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Other', handle: 'other' });

    await expect(
      help.helpSites.enable(workspaceId, projectId, authorId, { slug: 'again', sourceLocale: 'ko', locales: [] }),
    ).rejects.toBeInstanceOf(HelpSiteExistsError);
    await expect(
      help.helpSites.enable(workspaceId, other.id, authorId, { slug: 'showyourtime', sourceLocale: 'en', locales: [] }),
    ).rejects.toBeInstanceOf(HelpSlugTakenError);
    expect(await help.helpSites.get(workspaceId, projectId)).toMatchObject({
      slug: 'showyourtime',
      sourceLocale: 'ko',
    });
  });

  it('shows an article publicly only once published, and keeps the published text while the draft changes', async () => {
    const { article } = await setUp();
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, {
      articleId: article.id,
      title: '위젯 기능',
      body: '홈 화면에 위젯을 추가하세요.',
    });
    const before = await help.helpPublic.tree('showyourtime', 'ko');

    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, {
      articleId: article.id,
      title: '위젯 기능',
      body: '홈 화면에 위젯을 추가하고 크기를 고르세요.',
    });
    const served = await help.helpPublic.article('showyourtime', 'ko', `${article.shortId}-old-slug`);
    const [tree] = await help.helpAuthoring.tree(workspaceId, projectId);

    expect(before.collections).toEqual([]);
    expect(served).toMatchObject({
      title: '위젯 기능',
      body: '홈 화면에 위젯을 추가하세요.',
      canonicalPath: `/ko/articles/${article.shortId}-widget-features`,
    });
    expect(tree?.sections[0]?.articles[0]).toMatchObject({ status: 'published', hasUnpublishedChanges: true });

    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
    const republished = await help.helpPublic.article('showyourtime', 'ko', article.shortId);
    expect(republished?.body).toBe('홈 화면에 위젯을 추가하고 크기를 고르세요.');
  });

  it('serves the source language for a language the site does not have, and hides unpublished articles', async () => {
    const { article } = await setUp();
    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);

    const thai = await help.helpPublic.article('showyourtime', 'th', article.shortId);
    const tree = await help.helpPublic.tree('showyourtime', 'th');
    await help.helpAuthoring.unpublish(workspaceId, projectId, authorId, article.id);

    expect(thai).toMatchObject({ locale: 'ko', canonicalPath: `/ko/articles/${article.shortId}-widget-features` });
    expect(tree.collections[0]?.sections[0]?.articles.map(entry => entry.path)).toEqual([
      `/ko/articles/${article.shortId}-widget-features`,
    ]);
    const hidden = await help.helpPublic.tree('showyourtime', 'ko');
    expect(await help.helpPublic.article('showyourtime', 'ko', article.shortId)).toBeUndefined();
    expect(hidden.collections).toEqual([]);
  });

  it('keeps every save in history and restores an old one as the draft', async () => {
    const { article } = await setUp();
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, {
      articleId: article.id,
      title: 'v2',
      body: 'two',
    });
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, {
      articleId: article.id,
      title: 'v3',
      body: 'three',
    });
    const history = await help.helpAuthoring.history(workspaceId, projectId, article.id);
    const v2 = history.find(revision => revision.title === 'v2');

    const restored = await help.helpAuthoring.restore(workspaceId, projectId, authorId, article.id, v2?.id ?? '');

    expect(history.map(revision => revision.title)).toEqual(['v3', 'v2', 'Widget features']);
    expect(restored.draft).toMatchObject({ title: 'v2', body: 'two', kind: 'restore' });
    expect(await help.helpAuthoring.history(workspaceId, projectId, article.id)).toHaveLength(4);
  });

  it("never reaches another workspace's article, and redirects an imported path", async () => {
    const { article } = await setUp();
    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
    const otherWorkspace = expectOne(
      await t.db.insert(workspaces).values({ name: 'X', slug: randomUUID() }).returning(),
    ).id;
    await new HelpArticleRepo(t.db).insertRedirect({
      workspaceId,
      projectId,
      fromPath: '/features/widget-features',
      articleId: article.id,
    });

    await expect(help.helpAuthoring.article(otherWorkspace, projectId, article.id)).rejects.toBeInstanceOf(
      HelpNodeNotFoundError,
    );
    expect(await help.helpPublic.redirect('showyourtime', '/features/widget-features')).toBe(
      `/ko/articles/${article.shortId}-widget-features`,
    );
    expect(await help.helpPublic.redirect('showyourtime', '/nowhere')).toBeUndefined();
  });

  describe('import', () => {
    it('creates the tree, publishes, and keeps each old path as a redirect', async () => {
      await help.helpSites.enable(workspaceId, projectId, authorId, { slug: 'syt', sourceLocale: 'ko', locales: [] });

      const counts = await help.helpImport.importBundle(workspaceId, projectId, authorId, bundle('Widget'), {
        publish: true,
      });
      const tree = await help.helpPublic.tree('syt', 'ko');
      const redirect = await help.helpPublic.redirect('syt', '/features/widget-features');

      expect(counts).toEqual({ created: 2, updated: 0, unchanged: 0 });
      expect(tree.collections.map(collection => [collection.slug, collection.sections[0]?.articles.length])).toEqual([
        ['features', 2],
      ]);
      expect(redirect).toMatch(/^\/ko\/articles\/[a-z0-9]{6}-widget-features$/u);
    });

    it('updates only what changed when imported again, without duplicating', async () => {
      await help.helpSites.enable(workspaceId, projectId, authorId, { slug: 'syt', sourceLocale: 'ko', locales: [] });
      await help.helpImport.importBundle(workspaceId, projectId, authorId, bundle('Widget'), { publish: false });

      const again = await help.helpImport.importBundle(workspaceId, projectId, authorId, bundle('Widget v2'), {
        publish: false,
      });
      const [collection] = await help.helpAuthoring.tree(workspaceId, projectId);
      const articles = collection?.sections[0]?.articles ?? [];
      const widget = articles.find(article => article.slug === 'widget-features');
      const history = await help.helpAuthoring.history(workspaceId, projectId, widget?.id ?? '');

      expect(again).toEqual({ created: 0, updated: 1, unchanged: 1 });
      expect(articles.map(article => article.status)).toEqual(['draft', 'draft']);
      expect(history.map(revision => [revision.body, revision.kind])).toEqual([
        ['Widget v2', 'import'],
        ['Widget', 'import'],
      ]);
    });

    it('reuses an image the project already stored instead of uploading it again', async () => {
      const stored = { id: randomUUID() };
      const calls: string[] = [];
      const storage = {
        findReady: async ({ sha256 }: { sha256: string }) => {
          // eslint-disable-next-line sonarjs/null-dereference -- sha256 is a string, never null
          calls.push(`find ${sha256.slice(0, 4)}`);
          return await Promise.resolve(sha256 === 'a'.repeat(64) ? (stored as never) : undefined);
        },
        beginUpload: async () => {
          calls.push('begin');
          return await Promise.resolve({
            object: { id: 'new' } as never,
            upload: { url: 'u', method: 'PUT', headers: {} } as never,
          });
        },
        completeUpload: async () => await Promise.resolve({} as never),
        downloadUrl: async (_workspaceId: string, id: string) => await Promise.resolve(`https://cdn.test/${id}`),
      };
      const withStorage = createHelpDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), storage });
      await withStorage.helpSites.enable(workspaceId, projectId, authorId, {
        slug: 'syt',
        sourceLocale: 'ko',
        locales: [],
      });
      const image = { contentType: 'image/png' as const, sizeBytes: 10, filename: 'a.png' };

      const known = await withStorage.helpImport.createImageUpload(workspaceId, projectId, authorId, {
        ...image,
        sha256: 'a'.repeat(64),
      });
      const fresh = await withStorage.helpImport.createImageUpload(workspaceId, projectId, authorId, {
        ...image,
        sha256: 'b'.repeat(64),
      });

      expect(known).toEqual({ url: `https://cdn.test/${stored.id}` });
      expect(fresh).toMatchObject({ objectId: 'new' });
      expect(calls).toEqual(['find aaaa', 'find bbbb', 'begin']);
    });

    it('refuses image uploads without object storage', async () => {
      await help.helpSites.enable(workspaceId, projectId, authorId, { slug: 'syt', sourceLocale: 'ko', locales: [] });

      await expect(
        help.helpImport.createImageUpload(workspaceId, projectId, authorId, {
          contentType: 'image/png',
          sizeBytes: 10,
          filename: 'a.png',
        }),
      ).rejects.toBeInstanceOf(HelpStorageNotConfiguredError);
    });
  });
});
