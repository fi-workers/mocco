import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { createHelpHandlers, HelpJobKinds } from '@backend/domain/helpcenter/jobs';
import { structureProblem } from '@backend/domain/helpcenter/markdown/validate';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { HelpTranslationUsageRepo } from '@backend/domain/helpcenter/repos/translation-usage.repo';
import { HelpTranslationRepo } from '@backend/domain/helpcenter/repos/translation.repo';
import { MAX_SEGMENT_ATTEMPTS } from '@backend/domain/helpcenter/translate/pipeline';
import { TranslationOutcomes } from '@backend/domain/helpcenter/translate/state';
import { FakeTranslator } from '@backend/domain/helpcenter/translate/testing/fake-translator';
import { RetryAt } from '@backend/domain/jobs/retry-at';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';
import type { JobContext } from '@backend/domain/jobs/handlers';

const BODY = '## Add the widget\n\nTap [here](https://a.test).\n\n```\nnpm i\n```';
const LINK_SEGMENT = 'Tap ⟦0⟧here⟦/0⟧.';
const NOW = new Date('2026-10-06T09:00:00Z');

interface Job {
  articleId: string;
  workspaceId: string;
  locale: string;
  fresh?: boolean;
}

/** Every segment text sent into `locale`, across calls. */
const sentTo = (translator: FakeTranslator, locale: string) =>
  translator.calls.flatMap(call => (call.targetLocale === locale ? call.segments.map(s => s.text) : []));

describe('help center translation (pglite)', () => {
  let t: TestDb;
  let workspaceId: string;
  let projectId: string;
  let authorId: string;
  let queued: Job[];

  /** A domain whose queue records jobs; `drain` runs them. */
  const domainWith = (
    translator: FakeTranslator,
    opts: { monthlyCharacters?: number } = {},
  ): HelpDomain & { drain: () => Promise<void> } => {
    const domain = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      translator,
      now: () => NOW,
      ...(opts.monthlyCharacters !== undefined && { translationMonthlyCharacters: opts.monthlyCharacters }),
      queue: {
        enqueue: async (_job, payload) => {
          queued.push(payload as Job);
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

  const republish = async (help: HelpDomain, articleId: string, body: string) => {
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, { articleId, title: 'Widget', body });
    await help.helpAuthoring.publish(workspaceId, projectId, authorId, articleId);
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
    await republish(help, article.id, BODY);
    return article;
  };

  const stateOf = async (help: HelpDomain, articleId: string, locale: string) => {
    const { locales } = await help.helpTranslations.translations(workspaceId, projectId, articleId);
    return locales.find(entry => entry.locale === locale);
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

  it('translates on publish into every offered language, segment by segment, and serves it', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    const article = await published(help);

    await help.drain();
    const english = await help.helpPublic.article('syt', 'en', article.shortId);
    const tree = await help.helpPublic.tree('syt', 'ja');
    const states = await help.helpTranslations.translations(workspaceId, projectId, article.id);

    expect(english).toMatchObject({
      locale: 'en',
      title: 'EN Widget',
      canonicalPath: `/en/articles/${article.shortId}-widget`,
      locales: ['ko', 'en', 'ja'],
      modifiedAt: expect.any(Date),
    });
    expect(english?.body).toContain('## EN Add the widget');
    expect(english?.body).toContain('EN Tap [here](https://a.test).');
    expect(english?.body).toContain('```\nnpm i\n```');
    expect(tree.collections[0]?.sections[0]?.articles[0]).toMatchObject({ title: 'JA Widget' });
    expect([tree.collections[0]?.title, tree.collections[0]?.sections[0]?.title]).toEqual(['JA Start', 'JA Basics']);
    // One call per language; code and the link target never leave Mocco.
    expect(translator.calls).toHaveLength(2);
    expect(sentTo(translator, 'en')).toEqual(['Widget', 'Add the widget', LINK_SEGMENT, 'Start', 'Basics']);
    expect(translator.sent.join('\n')).not.toMatch(/a\.test|npm/u);
    expect(states.locales.map(entry => [entry.locale, entry.state, entry.isStale, entry.hasProposal])).toEqual([
      ['en', 'auto', false, false],
      ['ja', 'auto', false, false],
    ]);
  });

  it('lists each published article in the languages it is served in, for the sitemap', async () => {
    const help = domainWith(new FakeTranslator());
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
      title: 'EN Widget',
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

  it('re-sends only the segments a source edit changed; the rest come from translation memory', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    const article = await published(help);
    await help.drain();
    translator.calls.length = 0;

    await republish(help, article.id, BODY.replace('## Add the widget', '## Add the widget\n\nIt fits any screen.'));
    await help.drain();
    const japanese = await help.helpPublic.article('syt', 'ja', article.shortId);

    // The titles are known too: only the new paragraph goes out, once per language.
    expect(sentTo(translator, 'ja')).toEqual(['It fits any screen.']);
    expect(sentTo(translator, 'en')).toEqual(['It fits any screen.']);
    expect(japanese?.body).toContain('## JA Add the widget\n\nJA It fits any screen.\n\nJA Tap [here]');
    expect(await stateOf(help, article.id, 'ja')).toMatchObject({ state: 'auto', isStale: false });
  });

  it('never overwrites a reviewed translation; a stale one gets a proposal that keeps the person’s segments', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    const article = await published(help);
    await help.drain();
    await help.helpTranslations.saveTranslation(workspaceId, projectId, authorId, {
      articleId: article.id,
      locale: 'en',
      title: 'Widget (reviewed)',
      body: BODY.replace('Tap', 'Press'),
    });
    translator.calls.length = 0;

    await republish(help, article.id, `${BODY}\n\nNew line.`);
    const requeued = queued.map(job => job.locale);
    await help.drain();
    const english = await help.helpPublic.article('syt', 'en', article.shortId);
    const row = await new HelpTranslationRepo(t.db).find(workspaceId, article.id, 'en');
    const [proposal] = await new HelpArticleRepo(t.db).revisionsByIds([row?.proposalRevisionId ?? randomUUID()]);

    expect(new Set(requeued)).toEqual(new Set(['en', 'ja']));
    expect(await stateOf(help, article.id, 'en')).toMatchObject({
      state: 'reviewed',
      isStale: true,
      hasProposal: true,
    });
    expect(await stateOf(help, article.id, 'ja')).toMatchObject({ state: 'auto', isStale: false });
    expect(english?.title).toBe('Widget (reviewed)');
    expect(english?.body).toContain('Press [here](https://a.test).');
    expect(english?.body).not.toContain('New line');
    // The person's sentences are kept; only the new one is drafted by the machine.
    expect(sentTo(translator, 'en')).toEqual(['New line.']);
    expect(proposal).toMatchObject({ kind: 'proposal', title: 'Widget (reviewed)' });
    expect(proposal?.bodyMd).toContain('Press [here](https://a.test).\n\n```\nnpm i\n```\n\nEN New line.');

    // A run on the same source again does nothing: the proposal is already there.
    const again = await help.helpTranslations.translateArticle({ workspaceId, articleId: article.id, locale: 'en' });
    expect(again.outcome).toBe(TranslationOutcomes.upToDate);
  });

  it('keeps a person’s text that was saved while a run was out (the invariant under a race)', async () => {
    const holder: { help?: HelpDomain; articleId?: string } = {};
    const translator = new FakeTranslator({
      beforeAnswer: async () => {
        if (holder.help === undefined || holder.articleId === undefined) {
          return;
        }
        const { help, articleId } = holder;
        holder.help = undefined;
        await help.helpTranslations.saveTranslation(workspaceId, projectId, authorId, {
          articleId,
          locale: 'en',
          title: 'Widget (by Ada)',
          body: BODY,
        });
      },
    });
    const help = domainWith(translator);
    const article = await published(help);
    holder.help = help;
    holder.articleId = article.id;

    const result = await help.helpTranslations.translateArticle({ workspaceId, articleId: article.id, locale: 'en' });
    const english = await help.helpPublic.article('syt', 'en', article.shortId);

    expect(result.outcome).toBe(TranslationOutcomes.upToDate);
    expect(english?.title).toBe('Widget (by Ada)');
    expect(await stateOf(help, article.id, 'en')).toMatchObject({ state: 'reviewed', hasProposal: false });
  });

  it('does nothing for a source already translated, and translates once under concurrent claims', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    const article = await published(help);
    const key = { workspaceId, articleId: article.id, locale: 'en' };

    const [first, second] = await Promise.all([
      help.helpTranslations.translateArticle(key),
      help.helpTranslations.translateArticle(key),
    ]);
    const revisions = await new HelpArticleRepo(t.db).history(workspaceId, article.id, 'en', 10);
    const repeat = await help.helpTranslations.translateArticle(key);

    expect([first.outcome, second.outcome].toSorted((a, b) => a.localeCompare(b))).toEqual([
      TranslationOutcomes.busy,
      TranslationOutcomes.translated,
    ]);
    expect(translator.calls).toHaveLength(1);
    expect(revisions).toHaveLength(1);
    expect(repeat.outcome).toBe(TranslationOutcomes.upToDate);
    expect(translator.calls).toHaveLength(1);
    expect(await new HelpArticleRepo(t.db).history(workspaceId, article.id, 'en', 10)).toHaveLength(1);
  });

  it('defers a job that finds another run holding the translation, free of an attempt', async () => {
    const help = domainWith(new FakeTranslator());
    const article = await published(help);
    const until = new Date(NOW.getTime() + 60_000);
    await new HelpTranslationRepo(t.db).upsert({
      workspaceId,
      articleId: article.id,
      locale: 'en',
      state: 'translating',
      claimedUntil: until,
    });
    const handler = createHelpHandlers({ translations: help.helpTranslations }).find(
      candidate => candidate.kind === HelpJobKinds.translate,
    );
    const ctx = { deadline: new Date(NOW.getTime() + 300_000) } as JobContext;

    const run = handler?.run({ workspaceId, articleId: article.id, locale: 'en' }, ctx);

    await expect(run).rejects.toBeInstanceOf(RetryAt);
    await expect(run).rejects.toMatchObject({ at: until, isFreeWait: true });
  });

  it('asks again for a refused segment, then fails without publishing a broken translation', async () => {
    const flaky = new FakeTranslator({ refuse: { text: LINK_SEGMENT, times: 1 } });
    const recovered = domainWith(flaky);
    const article = await published(recovered);
    await recovered.helpTranslations.translateArticle({ workspaceId, articleId: article.id, locale: 'en' });

    expect(flaky.calls.map(call => [call.segments.map(s => s.text), call.isRetry ?? false])).toEqual([
      [['Widget', 'Add the widget', LINK_SEGMENT, 'Start', 'Basics'], false],
      [[LINK_SEGMENT], true],
    ]);
    expect(await stateOf(recovered, article.id, 'en')).toMatchObject({ state: 'auto' });

    const broken = new FakeTranslator({ refuse: { text: LINK_SEGMENT, times: 99 } });
    const help = domainWith(broken);
    const result = await help.helpTranslations.translateArticle({ workspaceId, articleId: article.id, locale: 'ja' });
    const japanese = await help.helpPublic.article('syt', 'ja', article.shortId);

    expect(result.outcome).toBe(TranslationOutcomes.refused);
    expect(sentTo(broken, 'ja').filter(text => text === LINK_SEGMENT)).toHaveLength(MAX_SEGMENT_ATTEMPTS);
    expect(await stateOf(help, article.id, 'ja')).toMatchObject({
      state: 'failed',
      lastError: expect.stringContaining('a new link'),
    });
    expect(japanese).toMatchObject({ locale: 'ko', canonicalPath: `/ko/articles/${article.shortId}-widget` });
    // The segments that did validate are kept, so the next run sends only the refused one.
    const healed = new FakeTranslator();
    await domainWith(healed).helpTranslations.translateArticle({ workspaceId, articleId: article.id, locale: 'ja' });
    expect(healed.sent).toEqual([LINK_SEGMENT]);
    expect(await stateOf(help, article.id, 'ja')).toMatchObject({ state: 'auto', lastError: null });
  });

  it('meters the characters sent, and stops at the monthly allowance leaving languages pending with the reason', async () => {
    const metered = new FakeTranslator();
    const help = domainWith(metered, { monthlyCharacters: 1000 });
    const article = await published(help);
    await help.drain();
    const used = await new HelpTranslationUsageRepo(t.db).used(workspaceId, '2026-10-01');

    expect(used).toBe(metered.sent.join('').length);

    const tight = new FakeTranslator();
    const capped = domainWith(tight, { monthlyCharacters: used + 5 });
    await republish(capped, article.id, `${BODY}\n\nA brand new paragraph.`);
    await capped.drain();

    expect(tight.calls).toHaveLength(0);
    const waiting = {
      state: 'pending',
      isStale: true,
      lastError: expect.stringContaining('translated characters for the month'),
    };
    expect(await stateOf(capped, article.id, 'en')).toMatchObject(waiting);
    expect(await stateOf(capped, article.id, 'ja')).toMatchObject(waiting);
    // The previous translation keeps being served meanwhile.
    const english = await capped.helpPublic.article('syt', 'en', article.shortId);
    expect(english?.title).toBe('EN Widget');
    expect(await new HelpTranslationUsageRepo(t.db).used(workspaceId, '2026-10-01')).toBe(used);
  });

  it('gives back the characters and lets go of the claim on an outage, so the job retries', async () => {
    const help = domainWith(new FakeTranslator({ failWith: new Error('503') }));
    const article = await published(help);

    await expect(
      help.helpTranslations.translateArticle({ workspaceId, articleId: article.id, locale: 'en' }),
    ).rejects.toThrow('503');
    const row = await new HelpTranslationRepo(t.db).find(workspaceId, article.id, 'en');

    expect(row).toMatchObject({ state: 'pending', claimedUntil: null });
    expect(await new HelpTranslationUsageRepo(t.db).used(workspaceId, '2026-10-01')).toBe(0);
  });

  it('translates again without translation memory when asked, replacing a reviewed text', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    const article = await published(help);
    await help.drain();
    await help.helpTranslations.saveTranslation(workspaceId, projectId, authorId, {
      articleId: article.id,
      locale: 'en',
      title: 'Widget (reviewed)',
      body: BODY,
    });
    translator.calls.length = 0;

    await help.helpTranslations.retranslate(workspaceId, projectId, article.id, 'en');
    await help.drain();

    expect(sentTo(translator, 'en')).toEqual(['Widget', 'Add the widget', LINK_SEGMENT]);
    expect(await stateOf(help, article.id, 'en')).toMatchObject({ state: 'auto', title: 'EN Widget' });
  });

  it('checks headings, code blocks and link targets', () => {
    expect(structureProblem(BODY, BODY.replace('Tap', 'Touchez'))).toBeNull();
    expect(structureProblem(BODY, BODY.replace('## Add', '### Add'))).toContain('headings');
    expect(structureProblem(BODY, BODY.replace('npm i', 'npm install'))).toContain('code');
    expect(structureProblem(BODY, BODY.replace('a.test', 'b.test'))).toContain('link');
  });
});
