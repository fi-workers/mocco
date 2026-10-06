/* eslint-disable sonarjs/null-dereference -- the fake translator's answers are strings, never null */
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { GlossaryRules, TranslationStates } from '@mocco/common/help';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { HelpGlossaryTermExistsError, HelpGlossaryTermNotFoundError } from '@backend/domain/helpcenter/errors';
import { createHelpHandlers, HelpJobKinds } from '@backend/domain/helpcenter/jobs';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { HelpTranslationRepo } from '@backend/domain/helpcenter/repos/translation.repo';
import { TranslationOutcomes } from '@backend/domain/helpcenter/translate/state';
import { FakeTranslator } from '@backend/domain/helpcenter/translate/testing/fake-translator';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';
import type { JobContext } from '@backend/domain/jobs/handlers';

const NOW = new Date('2026-10-06T09:00:00Z');

/** An article that mentions the gate and the widget in one paragraph each. */
const GATE_BODY = '## Get started\n\nOpen the Mocco Gate to deploy.\n\nThe widget shows your time.\n\nPress Save.';
/** An article that mentions no glossary term. */
const PLAIN_BODY = 'Pick a color.\n\nTap Done.';

interface Queued {
  kind: string;
  payload: Record<string, unknown>;
}

interface TranslateJob {
  workspaceId: string;
  articleId: string;
  locale: string;
}

describe('help center glossary (pglite)', () => {
  let t: TestDb;
  let workspaceId: string;
  let projectId: string;
  let authorId: string;
  let queued: Queued[];

  /** A domain whose queue records jobs; `drain` runs them (and what they queue) until none is left. */
  const domainWith = (translator: FakeTranslator) => {
    const domain = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      translator,
      now: () => NOW,
      queue: {
        enqueue: async (job, payload) => {
          queued.push({ kind: job.kind, payload: payload as Record<string, unknown> });
          return await Promise.resolve({ job: { id: randomUUID() } as never, created: true });
        },
        kick: () => {},
      },
    });
    const handlers = createHelpHandlers({ translations: domain.helpTranslations });
    const outcomes: string[] = [];
    const drain = async () => {
      while (queued.length > 0) {
        const jobs = [...queued];
        queued.length = 0;
        // eslint-disable-next-line no-await-in-loop -- a fan-out queues the runs the next round drains
        await Promise.all(
          jobs.map(async ({ kind, payload }) => {
            if (kind === HelpJobKinds.translate) {
              const { outcome } = await domain.helpTranslations.translateArticle(payload as unknown as TranslateJob);
              outcomes.push(outcome);
              return;
            }
            const handler = handlers.find(candidate => candidate.kind === kind);
            await handler?.run(payload, { deadline: new Date(NOW.getTime() + 60_000) } as JobContext);
          }),
        );
      }
    };
    return { ...domain, drain, outcomes };
  };

  const enable = async (help: HelpDomain) => {
    await help.helpSites.enable(workspaceId, projectId, authorId, {
      slug: 'syt',
      sourceLocale: 'en',
      locales: ['de', 'fr'],
    });
  };

  /** Two published articles on the site: one mentions the glossary's terms, one doesn't. */
  const articles = async (help: HelpDomain) => {
    const collection = await help.helpAuthoring.createCollection(workspaceId, projectId, {
      title: 'Start',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, projectId, {
      collectionId: collection.id,
      title: 'Basics',
    });
    const publish = async (title: string, slug: string, body: string) => {
      const article = await help.helpAuthoring.createArticle(workspaceId, projectId, authorId, {
        sectionId: section.id,
        title,
        slug,
      });
      await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, { articleId: article.id, title, body });
      await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
      return article;
    };
    return {
      gate: await publish('Gate basics', 'gate', GATE_BODY),
      plain: await publish('Colors', 'colors', PLAIN_BODY),
    };
  };

  const languageOf = async (help: HelpDomain, articleId: string, locale: string) => {
    const { locales } = await help.helpTranslations.translations(workspaceId, projectId, articleId);
    return locales.find(entry => entry.locale === locale);
  };

  const bodyIn = async (help: HelpDomain, articleId: string, locale: string) => {
    const language = await languageOf(help, articleId, locale);
    return language?.body;
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

  it('keeps a keep term as written in every language: the translator never sees it', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    await enable(help);
    await help.helpGlossary.addTerm(workspaceId, projectId, authorId, { term: 'Mocco Gate', rule: GlossaryRules.keep });
    const { gate } = await articles(help);
    await help.drain();

    const sent = translator.sent.join('\n');
    expect(sent).not.toContain('Mocco Gate');
    expect(sent).toContain('Open the ⟦0⟧ to deploy.');
    expect(await languageOf(help, gate.id, 'de')).toMatchObject({
      state: TranslationStates.auto,
      body: expect.stringContaining('DE Open the Mocco Gate to deploy.'),
    });
    expect(await languageOf(help, gate.id, 'fr')).toMatchObject({
      state: TranslationStates.auto,
      body: expect.stringContaining('FR Open the Mocco Gate to deploy.'),
    });
  });

  it('refuses an answer that drops a kept term (the validator enforces it)', async () => {
    // A translator that writes the term out in its own words instead of keeping the placeholder.
    const translator = new FakeTranslator({ rewrite: answer => answer.replaceAll('⟦0⟧', 'Mocco-Tor') });
    const help = domainWith(translator);
    await enable(help);
    await help.helpGlossary.addTerm(workspaceId, projectId, authorId, { term: 'Mocco Gate', rule: GlossaryRules.keep });
    const { gate } = await articles(help);
    await help.drain();

    const de = await languageOf(help, gate.id, 'de');
    expect(de).toMatchObject({ state: TranslationStates.failed, body: null });
    expect(de?.lastError).toContain('the placeholder ⟦0⟧ is missing');
  });

  it('writes a fixed term as its translation, and refuses an answer without it', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    await enable(help);
    await help.helpGlossary.addTerm(workspaceId, projectId, authorId, {
      term: 'widget',
      rule: GlossaryRules.fixed,
      translations: { de: 'Steuerelement' },
    });
    const { gate } = await articles(help);
    await help.drain();

    // Sent with the batch that contains it, into the language it has a translation for.
    expect(translator.calls.find(call => call.targetLocale === 'de')?.glossary).toEqual([
      { term: 'widget', target: 'Steuerelement' },
    ]);
    expect(translator.calls.find(call => call.targetLocale === 'fr')?.glossary).toBeUndefined();
    expect(await bodyIn(help, gate.id, 'de')).toContain('DE The Steuerelement shows your time.');

    const ignoring = new FakeTranslator({ rewrite: answer => answer.replaceAll('Steuerelement', 'widget') });
    const again = domainWith(ignoring);
    await again.helpTranslations.retranslate(workspaceId, projectId, authorId, { articleId: gate.id, locale: 'de' });
    await again.drain();
    const de = await languageOf(again, gate.id, 'de');
    expect(de?.state).toBe(TranslationStates.failed);
    expect(de?.lastError).toContain('the glossary term "widget" must be translated as "Steuerelement"');
    // The text that followed the glossary keeps being served.
    expect(de?.body).toContain('DE The Steuerelement shows your time.');
  });

  it('re-translates only the segments that contain a changed term (and only in the languages it changes)', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    await enable(help);
    const { gate, plain } = await articles(help);
    await help.drain();
    translator.forget();
    help.outcomes.length = 0;

    // A fixed translation into German: only the German segment with the widget misses memory.
    const term = await help.helpGlossary.addTerm(workspaceId, projectId, authorId, {
      term: 'widget',
      rule: GlossaryRules.fixed,
      translations: { de: 'Steuerelement' },
    });
    expect(queued.map(job => job.kind)).toEqual([HelpJobKinds.retranslateGlossary]);
    await help.drain();
    expect(translator.calls).toHaveLength(1);
    expect(translator.sent).toEqual(['The widget shows your time.']);
    expect(help.outcomes).toEqual([TranslationOutcomes.translated]);
    expect(await bodyIn(help, gate.id, 'de')).toBe(
      '## DE Get started\n\nDE Open the Mocco Gate to deploy.\n\nDE The Steuerelement shows your time.\n\nDE Press Save.\n',
    );

    // Changing that term's translation: the same one segment again, and nothing else.
    translator.forget();
    help.outcomes.length = 0;
    await help.helpGlossary.updateTerm(workspaceId, projectId, authorId, term.id, {
      term: 'widget',
      rule: GlossaryRules.fixed,
      translations: { de: 'Anzeige' },
    });
    await help.drain();
    expect(translator.sent).toEqual(['The widget shows your time.']);
    expect(await bodyIn(help, gate.id, 'de')).toContain('DE The Anzeige shows your time.');

    // A kept term: the paragraph it's in, in both languages; the article without it isn't touched.
    translator.forget();
    await help.helpGlossary.addTerm(workspaceId, projectId, authorId, { term: 'Mocco Gate', rule: GlossaryRules.keep });
    await help.drain();
    expect(translator.calls.map(call => [call.targetLocale, call.segments.map(s => s.text)])).toEqual(
      expect.arrayContaining([
        ['de', ['Open the ⟦0⟧ to deploy.']],
        ['fr', ['Open the ⟦0⟧ to deploy.']],
      ]),
    );
    expect(translator.calls).toHaveLength(2);
    const plainRows = await new HelpTranslationRepo(t.db).forArticle(workspaceId, plain.id);
    expect(plainRows.map(row => row.glossaryHash)).toEqual(['', '']);
  });

  it('a glossary edit invalidates the cached segment translations it affects', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    await enable(help);
    const { gate } = await articles(help);
    await help.drain();
    const term = await help.helpGlossary.addTerm(workspaceId, projectId, authorId, {
      term: 'widget',
      rule: GlossaryRules.fixed,
      translations: { de: 'Steuerelement' },
    });
    await help.drain();
    translator.forget();

    // Translating again from memory: every segment is cached under the current glossary.
    await help.helpTranslations.retranslate(workspaceId, projectId, authorId, { articleId: gate.id, locale: 'de' });
    queued.length = 0;
    await help.helpTranslations.translateArticle({ workspaceId, articleId: gate.id, locale: 'de' });
    expect(translator.calls).toHaveLength(0);

    // Removing the term: the cache entry made under it no longer answers, the one from before it does.
    await help.helpGlossary.removeTerm(workspaceId, projectId, authorId, term.id);
    await help.drain();
    expect(translator.calls).toHaveLength(0);
    expect(await bodyIn(help, gate.id, 'de')).toContain('DE The widget shows your time.');
  });

  it('drafts a proposal beside a reviewed translation, keeping the person’s other sentences', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    await enable(help);
    const { gate } = await articles(help);
    await help.drain();
    const reviewed = {
      articleId: gate.id,
      locale: 'de' as const,
      title: 'Gate-Grundlagen',
      body: '## Los geht es\n\nOffne das Mocco Gate.\n\nDas widget zeigt die Zeit.\n\nDrucke Sichern.',
    };
    await help.helpTranslations.saveTranslation(workspaceId, projectId, authorId, reviewed);
    translator.forget();
    help.outcomes.length = 0;

    await help.helpGlossary.addTerm(workspaceId, projectId, authorId, {
      term: 'widget',
      rule: GlossaryRules.fixed,
      translations: { de: 'Steuerelement' },
    });
    await help.drain();

    expect(translator.sent).toEqual(['The widget shows your time.']);
    expect(help.outcomes).toEqual([TranslationOutcomes.proposed]);
    const review = await help.helpTranslations.review(workspaceId, projectId, gate.id, 'de');
    expect(review).toMatchObject({ state: TranslationStates.reviewed, text: { body: reviewed.body } });
    expect(review.proposal?.body).toBe(
      '## Los geht es\n\nOffne das Mocco Gate.\n\nDE The Steuerelement shows your time.\n\nDrucke Sichern.\n',
    );
    const language = await languageOf(help, gate.id, 'de');
    expect(language?.hasProposal).toBe(true);

    // Accepting it makes it the reviewed text under the current glossary: the next fan-out leaves it.
    await help.helpTranslations.acceptProposal(workspaceId, projectId, authorId, {
      articleId: gate.id,
      locale: 'de',
      proposalRevisionId: review.proposal?.revisionId ?? '',
    });
    expect(await help.helpTranslations.retranslateForGlossary(workspaceId, projectId)).toBe(0);
  });

  it('manages terms: one per term whatever its case, audited, and imported in one change', async () => {
    const help = domainWith(new FakeTranslator());
    await enable(help);
    const added = await help.helpGlossary.addTerm(workspaceId, projectId, authorId, {
      term: 'Mocco',
      rule: GlossaryRules.keep,
    });
    await expect(
      help.helpGlossary.addTerm(workspaceId, projectId, authorId, { term: 'mocco', rule: GlossaryRules.keep }),
    ).rejects.toBeInstanceOf(HelpGlossaryTermExistsError);
    await expect(help.helpGlossary.removeTerm(workspaceId, projectId, authorId, randomUUID())).rejects.toBeInstanceOf(
      HelpGlossaryTermNotFoundError,
    );
    const { glossaryHash } = await help.helpGlossary.list(workspaceId, projectId);
    expect(glossaryHash).toMatch(/^[0-9a-f]{64}$/u);

    queued.length = 0;
    const imported = await help.helpGlossary.importTerms(workspaceId, projectId, authorId, [
      { term: 'MOCCO', rule: GlossaryRules.keep },
      { term: 'workspace', rule: GlossaryRules.fixed, translations: { de: 'Arbeitsbereich', fr: 'espace' } },
      { term: 'Mocco', rule: GlossaryRules.keep, note: 'Our name' },
    ]);
    expect(imported).toEqual({ added: 1, changed: 1, unchanged: 0 });
    const { terms } = await help.helpGlossary.list(workspaceId, projectId);
    expect(terms.map(term => [term.id === added.id, term.term, term.note])).toEqual([
      [true, 'Mocco', 'Our name'],
      [false, 'workspace', ''],
    ]);
    expect(queued.filter(job => job.kind === HelpJobKinds.retranslateGlossary)).toHaveLength(1);

    // The same import again changes nothing: no audit entry, no re-translation.
    queued.length = 0;
    expect(
      await help.helpGlossary.importTerms(workspaceId, projectId, authorId, [
        { term: 'workspace', rule: GlossaryRules.fixed, translations: { fr: 'espace', de: 'Arbeitsbereich' } },
      ]),
    ).toEqual({ added: 0, changed: 0, unchanged: 1 });
    expect(queued).toEqual([]);
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.action, AuditActions.helpGlossaryChanged)));
    expect(audits.map(entry => entry.payload)).toEqual([
      expect.objectContaining({ added: ['Mocco'] }),
      expect.objectContaining({ added: ['workspace'], changed: ['Mocco'] }),
    ]);
  });

  it('leaves an unpublished article and an untranslated language alone', async () => {
    const translator = new FakeTranslator();
    const help = domainWith(translator);
    await enable(help);
    const { gate } = await articles(help);
    await help.drain();
    await help.helpAuthoring.unpublish(workspaceId, projectId, authorId, gate.id);
    expect(await new HelpArticleRepo(t.db).published(workspaceId, projectId)).toHaveLength(1);
    translator.forget();

    await help.helpGlossary.addTerm(workspaceId, projectId, authorId, { term: 'Mocco Gate', rule: GlossaryRules.keep });
    await help.drain();
    expect(translator.calls).toHaveLength(0);
  });
});
