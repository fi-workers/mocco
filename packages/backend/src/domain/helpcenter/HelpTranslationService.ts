// Translating a help center (#96). Publishing an article queues a translation into each
// language the site offers; the job asks the translator, checks the Markdown kept its
// structure, and stores the text as a machine revision (`auto`). A person's text
// (`reviewed`) is never overwritten by the machine; when the source changes it is shown
// as stale instead, until someone edits it or asks for a new machine translation.
import { RevisionKinds, TranslationStates } from '@mocco/common/help';

import { revisionText } from '@backend/domain/helpcenter/content';
import { HelpNodeNotFoundError, HelpNothingToPublishError } from '@backend/domain/helpcenter/errors';
import { translateHelpArticle } from '@backend/domain/helpcenter/jobs';
import { structureProblem } from '@backend/domain/helpcenter/markdown/validate';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { HelpNodeTranslationRepo } from '@backend/domain/helpcenter/repos/node-translation.repo';
import { HelpSiteRepo } from '@backend/domain/helpcenter/repos/site.repo';
import { HelpTranslationRepo } from '@backend/domain/helpcenter/repos/translation.repo';
import { HelpTreeRepo } from '@backend/domain/helpcenter/repos/tree.repo';
import { TranslationRejectedError } from '@backend/domain/helpcenter/translate/Translator';

import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { HelpArticleRow } from '@backend/domain/helpcenter/repos/article.repo';
import type { HelpNode } from '@backend/domain/helpcenter/repos/node-translation.repo';
import type { Translator } from '@backend/domain/helpcenter/translate/Translator';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';
import type { TranslationInput } from '@mocco/common/help';

export interface HelpTranslationDeps {
  db: Db;
  sites: Pick<HelpSiteService, 'require'>;
  /** Without a translator (no LLM configured), nothing is translated automatically. */
  translator?: Translator;
  queue?: Pick<JobQueue, 'enqueue' | 'kick'>;
  /** Runs after a language's text changes (refreshes the article's public pages). */
  onTranslated?: (workspaceId: string, projectId: string, article: { shortId: string; slug: string }) => Promise<void>;
}

export class HelpTranslationService {
  constructor(private readonly deps: HelpTranslationDeps) {}

  private async requireArticle(workspaceId: string, projectId: string, articleId: string): Promise<HelpArticleRow> {
    const article = await new HelpArticleRepo(this.deps.db).find(workspaceId, projectId, articleId);
    if (article === undefined) {
      throw new HelpNodeNotFoundError('article', articleId);
    }
    return article;
  }

  private async queueLocale(workspaceId: string, articleId: string, locale: string): Promise<void> {
    const { queue } = this.deps;
    if (queue === undefined || this.deps.translator === undefined) {
      return;
    }
    await new HelpTranslationRepo(this.deps.db).upsert({
      workspaceId,
      articleId,
      locale,
      state: TranslationStates.pending,
      lastError: null,
    });
    const { job } = await queue.enqueue(
      translateHelpArticle,
      { workspaceId, articleId, locale },
      { dedupeKey: `${articleId}:${locale}`, workspaceId },
    );
    queue.kick(job.id);
  }

  /**
   * Translate the titles of an article's section and collection into `locale`, when they
   * have none yet or were renamed since. Titles are short, so they skip the structure
   * check; a failure leaves the source title showing.
   */
  private async translateNodeTitles(
    translator: Translator,
    target: { workspaceId: string; projectId: string; sectionId: string; sourceLocale: string; locale: string },
  ): Promise<void> {
    const { workspaceId, locale } = target;
    const found = await new HelpTreeRepo(this.deps.db).findSection(workspaceId, target.projectId, target.sectionId);
    if (found === undefined) {
      return;
    }
    const repo = new HelpNodeTranslationRepo(this.deps.db);
    const existing = await repo.inLocale(workspaceId, locale, {
      collectionIds: [found.collection.id],
      sectionIds: [found.section.id],
    });
    const nodes: { node: HelpNode; title: string; current: string | undefined }[] = [
      {
        node: { collectionId: found.collection.id },
        title: found.collection.title,
        current: existing.find(row => row.collectionId === found.collection.id)?.sourceTitle,
      },
      {
        node: { sectionId: found.section.id },
        title: found.section.title,
        current: existing.find(row => row.sectionId === found.section.id)?.sourceTitle,
      },
    ];
    await Promise.all(
      nodes.map(async ({ node, title, current }) => {
        if (current === title) {
          return;
        }
        try {
          const translated = await translator.translate({
            sourceLocale: target.sourceLocale,
            targetLocale: locale,
            title,
            body: '',
          });
          await repo.upsert({ workspaceId, locale, title: translated.title, sourceTitle: title, ...node });
        } catch {
          // The source title keeps showing; the next article translated here tries again.
        }
      }),
    );
  }

  /** Whether this deployment translates (an LLM is configured). */
  get isAvailable(): boolean {
    return this.deps.translator !== undefined && this.deps.queue !== undefined;
  }

  /** After a publish: queue a translation into every offered language that isn't reviewed. */
  async onPublished(workspaceId: string, projectId: string, articleId: string): Promise<void> {
    const site = await this.deps.sites.require(workspaceId, projectId);
    const repo = new HelpTranslationRepo(this.deps.db);
    const rows = await repo.forArticle(workspaceId, articleId);
    const existing = new Map(rows.map(row => [row.locale, row]));
    await Promise.all(
      site.locales
        .filter(locale => existing.get(locale)?.state !== TranslationStates.reviewed)
        .map(async locale => await this.queueLocale(workspaceId, articleId, locale)),
    );
  }

  /** The `help.translate` job: translate the published source into `locale`. */
  async translateArticle(input: { workspaceId: string; articleId: string; locale: string }): Promise<void> {
    const { translator } = this.deps;
    if (translator === undefined) {
      return;
    }
    const { workspaceId, articleId, locale } = input;
    const articleRepo = new HelpArticleRepo(this.deps.db);
    const repo = new HelpTranslationRepo(this.deps.db);
    const [article] = await articleRepo.byIds(workspaceId, [articleId]);
    if (article === undefined || article.publishedRevisionId === null) {
      return;
    }
    const site = await new HelpSiteRepo(this.deps.db).find(workspaceId, article.projectId);
    const [source] = await articleRepo.revisionsByIds([article.publishedRevisionId]);
    const current = await repo.find(workspaceId, articleId, locale);
    if (site === undefined || source === undefined || current?.state === TranslationStates.reviewed) {
      return;
    }
    if (current?.state === TranslationStates.auto && current.sourceHash === source.contentHash) {
      return;
    }
    try {
      const translated = await translator.translate({
        sourceLocale: site.sourceLocale,
        targetLocale: locale,
        title: source.title,
        body: source.bodyMd,
      });
      const problem = structureProblem(source.bodyMd, translated.body);
      if (problem !== null) {
        throw new TranslationRejectedError(`The translation was refused: ${problem}`);
      }
      const revision = await articleRepo.insertRevision({
        workspaceId,
        articleId,
        locale,
        ...revisionText(translated.title, translated.body),
        kind: RevisionKinds.machine,
        authorUserId: null,
      });
      await repo.upsert({
        workspaceId,
        articleId,
        locale,
        state: TranslationStates.auto,
        revisionId: revision.id,
        sourceHash: source.contentHash,
        lastError: null,
      });
      await this.translateNodeTitles(translator, {
        workspaceId,
        projectId: article.projectId,
        sectionId: article.sectionId,
        sourceLocale: site.sourceLocale,
        locale,
      });
      await this.deps.onTranslated?.(workspaceId, article.projectId, article);
    } catch (error) {
      if (!(error instanceof TranslationRejectedError)) {
        // An outage or a rate limit: the job retries.
        throw error;
      }
      await repo.upsert({ workspaceId, articleId, locale, state: TranslationStates.failed, lastError: error.message });
    }
  }

  /** Every offered language of an article: its state, whether it's stale, and its text. */
  async translations(workspaceId: string, projectId: string, articleId: string) {
    const site = await this.deps.sites.require(workspaceId, projectId);
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    const articleRepo = new HelpArticleRepo(this.deps.db);
    const translationRows = await new HelpTranslationRepo(this.deps.db).forArticle(workspaceId, articleId);
    const rows = new Map(translationRows.map(row => [row.locale, row]));
    const revisionIds = translationRows.flatMap(row => (row.revisionId === null ? [] : [row.revisionId]));
    const [source] =
      article.publishedRevisionId === null ? [] : await articleRepo.revisionsByIds([article.publishedRevisionId]);
    const revisions = await articleRepo.revisionsByIds(revisionIds);
    const texts = new Map(revisions.map(revision => [revision.id, revision]));
    return {
      isAvailable: this.isAvailable,
      locales: site.locales.map(locale => {
        const row = rows.get(locale);
        const text = texts.get(row?.revisionId ?? '');
        return {
          locale,
          state: row?.state ?? null,
          isStale:
            row?.sourceHash !== undefined &&
            row.sourceHash !== null &&
            source !== undefined &&
            row.sourceHash !== source.contentHash,
          lastError: row?.lastError ?? null,
          title: text?.title ?? null,
          body: text?.bodyMd ?? null,
          updatedAt: row?.updatedAt ?? null,
        };
      }),
    };
  }

  /** A person's translation: stored as `reviewed`, made from the current published source. */
  async saveTranslation(workspaceId: string, projectId: string, actorUserId: string, input: TranslationInput) {
    const article = await this.requireArticle(workspaceId, projectId, input.articleId);
    if (article.publishedRevisionId === null) {
      throw new HelpNothingToPublishError(article.id);
    }
    const articleRepo = new HelpArticleRepo(this.deps.db);
    const [source] = await articleRepo.revisionsByIds([article.publishedRevisionId]);
    const revision = await articleRepo.insertRevision({
      workspaceId,
      articleId: article.id,
      locale: input.locale,
      ...revisionText(input.title, input.body),
      kind: RevisionKinds.humanEdit,
      authorUserId: actorUserId,
    });
    await new HelpTranslationRepo(this.deps.db).upsert({
      workspaceId,
      articleId: article.id,
      locale: input.locale,
      state: TranslationStates.reviewed,
      revisionId: revision.id,
      sourceHash: source?.contentHash ?? null,
      lastError: null,
      reviewedByUserId: actorUserId,
    });
    await this.deps.onTranslated?.(workspaceId, projectId, article);
    return await this.translations(workspaceId, projectId, article.id);
  }

  /** Ask the machine again for one language, replacing a person's text if there is one. */
  async retranslate(workspaceId: string, projectId: string, articleId: string, locale: string) {
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    if (article.publishedRevisionId === null) {
      throw new HelpNothingToPublishError(article.id);
    }
    await this.queueLocale(workspaceId, article.id, locale);
    return await this.translations(workspaceId, projectId, article.id);
  }
}
