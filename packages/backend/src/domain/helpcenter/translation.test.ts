import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { structureProblem } from '@backend/domain/helpcenter/translate/validate';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';
import type { Translator } from '@backend/domain/helpcenter/translate/Translator';

/** Translates by prefixing every line with the target language; `breakLinks` changes a URL. */
const fakeTranslator = (opts: { breakLinks?: boolean } = {}): Translator & { calls: number } => {
  const fake = {
    name: 'fake',
    calls: 0,
    translate: async ({ targetLocale, title, body }: { targetLocale: string; title: string; body: string }) => {
      fake.calls += 1;
      // eslint-disable-next-line sonarjs/null-dereference -- body is a string, never null
      const translated = body.replaceAll('Tap', () => `[${targetLocale}] Tap`);
      return await Promise.resolve({
        title: `[${targetLocale}] ${title}`,
        body: opts.breakLinks === true ? translated.replace('https://a.test', 'https://evil.test') : translated,
      });
    },
  };
  return fake;
};

const BODY = '## Add the widget\n\nTap [here](https://a.test).\n\n```\nnpm i\n```';

describe('help center translation (pglite)', () => {
  let t: TestDb;
  let workspaceId: string;
  let projectId: string;
  let authorId: string;
  let queued: { articleId: string; workspaceId: string; locale: string }[];

  /** A domain whose queue records jobs; `drain` runs them. */
  const domainWith = (translator: Translator): HelpDomain & { drain: () => Promise<void> } => {
    const domain = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      translator,
      queue: {
        enqueue: async (_job, payload) => {
          queued.push(payload as (typeof queued)[number]);
          return await Promise.resolve({ job: { id: randomUUID() } as never, created: true });
        },
        kick: () => {},
      },
    });
    return {
      ...domain,
      drain: async () => {
        const jobs = [...queued];
        queued.length = 0;
        await Promise.all(jobs.map(async job => await domain.helpTranslations.translateArticle(job)));
      },
    };
  };

  /** A published article on a Korean site offered in English and Japanese. */
  const published = async (help: HelpDomain) => {
    await help.helpSites.enable(workspaceId, projectId, authorId, {
      slug: 'syt',
      sourceLocale: 'ko',
      locales: ['en', 'ja'],
    });
    const collection = await help.helpAuthoring.createCollection(workspaceId, projectId, {
      title: 'Start',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, projectId, {
      collectionId: collection.id,
      title: 'Basics',
    });
    const article = await help.helpAuthoring.createArticle(workspaceId, projectId, authorId, {
      sectionId: section.id,
      title: 'Widget',
      slug: 'widget',
    });
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, {
      articleId: article.id,
      title: 'Widget',
      body: BODY,
    });
    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
    return article;
  };

  beforeEach(async () => {
    t = await createTestDb();
    queued = [];
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

  it('translates on publish into every offered language and serves it', async () => {
    const translator = fakeTranslator();
    const help = domainWith(translator);
    const article = await published(help);

    await help.drain();
    const english = await help.helpPublic.article('syt', 'en', article.shortId);
    const tree = await help.helpPublic.tree('syt', 'ja');
    const states = await help.helpTranslations.translations(workspaceId, projectId, article.id);

    expect(english).toMatchObject({
      locale: 'en',
      title: '[en] Widget',
      canonicalPath: `/en/articles/${article.shortId}-widget`,
      locales: ['ko', 'en', 'ja'],
      modifiedAt: expect.any(Date),
    });
    expect(english?.body).toContain('[en] Tap [here](https://a.test).');
    expect(tree.collections[0]?.sections[0]?.articles[0]).toMatchObject({ title: '[ja] Widget' });
    expect([tree.collections[0]?.title, tree.collections[0]?.sections[0]?.title]).toEqual([
      '[ja] Start',
      '[ja] Basics',
    ]);
    expect(translator.calls).toBe(6);
    expect(states.locales.map(entry => [entry.locale, entry.state, entry.isStale])).toEqual([
      ['en', 'auto', false],
      ['ja', 'auto', false],
    ]);
  });

  it('lists each published article in the languages it is served in, for the sitemap', async () => {
    const help = domainWith(fakeTranslator());
    const article = await published(help);
    const before = await help.helpPublic.sitemap('syt');
    const untranslated = await help.helpPublic.article('syt', 'ko', article.shortId);
    const beforeAgents = await help.helpPublic.forAgents('syt', 'en');
    await help.drain();

    const after = await help.helpPublic.sitemap('syt');

    expect(before.articles).toEqual([
      [{ locale: 'ko', path: `/ko/articles/${article.shortId}-widget`, lastModified: expect.any(Date) }],
    ]);
    expect(untranslated?.locales).toEqual(['ko']);
    // Before it is translated, the English listing serves the source at the source's address.
    expect(beforeAgents.collections[0]?.sections[0]?.articles[0]).toMatchObject({
      title: 'Widget',
      body: BODY,
      path: `/ko/articles/${article.shortId}-widget`,
    });
    const forAgents = await help.helpPublic.forAgents('syt', 'en');
    expect(forAgents.collections[0]?.sections[0]?.articles[0]).toMatchObject({
      title: '[en] Widget',
      path: `/en/articles/${article.shortId}-widget`,
    });
    expect(after.homes.map(home => home.path)).toEqual(['/ko', '/en', '/ja']);
    expect(after.articles[0]?.map(version => version.path)).toEqual([
      `/ko/articles/${article.shortId}-widget`,
      `/en/articles/${article.shortId}-widget`,
      `/ja/articles/${article.shortId}-widget`,
    ]);
    await help.helpAuthoring.unpublish(workspaceId, projectId, authorId, article.id);
    const unpublished = await help.helpPublic.sitemap('syt');
    expect(unpublished.articles).toEqual([]);
  });

  it('keeps a reviewed translation when the source changes, showing it as stale', async () => {
    const help = domainWith(fakeTranslator());
    const article = await published(help);
    await help.drain();
    await help.helpTranslations.saveTranslation(workspaceId, projectId, authorId, {
      articleId: article.id,
      locale: 'en',
      title: 'Widget (reviewed)',
      body: BODY.replace('Tap', 'Press'),
    });

    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, {
      articleId: article.id,
      title: 'Widget',
      body: `${BODY}\n\nNew line.`,
    });
    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
    const requeued = queued.map(job => job.locale);
    await help.drain();
    const states = await help.helpTranslations.translations(workspaceId, projectId, article.id);
    const english = await help.helpPublic.article('syt', 'en', article.shortId);

    expect(requeued).toEqual(['ja']);
    expect(states.locales.find(entry => entry.locale === 'en')).toMatchObject({ state: 'reviewed', isStale: true });
    expect(states.locales.find(entry => entry.locale === 'ja')).toMatchObject({ state: 'auto', isStale: false });
    expect(english?.title).toBe('Widget (reviewed)');
  });

  it('refuses a translation that changes a link, and serves the source instead', async () => {
    const help = domainWith(fakeTranslator({ breakLinks: true }));
    const article = await published(help);

    await help.drain();
    const states = await help.helpTranslations.translations(workspaceId, projectId, article.id);
    const english = await help.helpPublic.article('syt', 'en', article.shortId);

    expect(states.locales[0]).toMatchObject({ state: 'failed', lastError: expect.stringContaining('link') });
    expect(english).toMatchObject({ locale: 'ko', canonicalPath: `/ko/articles/${article.shortId}-widget` });
  });

  it('checks headings, code blocks and link targets', () => {
    expect(structureProblem(BODY, BODY.replace('Tap', 'Touchez'))).toBeNull();
    expect(structureProblem(BODY, BODY.replace('## Add', '### Add'))).toContain('headings');
    expect(structureProblem(BODY, BODY.replace('npm i', 'npm install'))).toContain('code');
    expect(structureProblem(BODY, BODY.replace('a.test', 'b.test'))).toContain('link');
  });
});
