import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { HelpNodeNotFoundError, HelpSiteExistsError, HelpSlugTakenError } from '@backend/domain/helpcenter/errors';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';

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
});
