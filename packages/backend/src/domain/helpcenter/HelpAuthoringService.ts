// Writing a help center (#96): collections → sections → articles, drafts saved as
// revisions, publishing, unpublishing and restoring. Callers are workspace members,
// checked by the tRPC procedure; every query is scoped by workspace and project.
//
// The editor saves as you type (#208). Saves by the same person within an editing session
// land in the current draft revision instead of a new one each time, so history reads
// as one entry per session. A revision that is published, restored or imported, or
// written by someone else, is never changed: the next save starts a new one.

import { AuditActions } from '@mocco/common/audit';
import { ArticleStatuses, RevisionKinds, slugify } from '@mocco/common/help';

import { contentHashOf, newShortId, revisionText } from '@backend/domain/helpcenter/content';
import {
  HelpNodeNotFoundError,
  HelpNothingToPublishError,
  HelpSlugTakenError,
} from '@backend/domain/helpcenter/errors';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { HelpTreeRepo } from '@backend/domain/helpcenter/repos/tree.repo';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { HelpArticleRow, HelpRevisionRow } from '@backend/domain/helpcenter/repos/article.repo';
import type { Db } from '@backend/infra/db/types';
import type { ArticleCreateInput, CollectionInput, DraftInput, RevisionKind, SectionInput } from '@mocco/common/help';

export interface HelpAuthoringDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  sites: Pick<HelpSiteService, 'require'>;
  /** Runs after a publish (queues the article's translations). */
  onPublished?: (workspaceId: string, projectId: string, articleId: string) => Promise<void>;
  /** Runs after a change readers see: a publish, an unpublish or a delete (refreshes the pages). */
  onPublicChange?: (
    workspaceId: string,
    projectId: string,
    article: { shortId: string; slug: string },
  ) => Promise<void>;
  now?: () => Date;
}

const HISTORY_LIMIT = 50;
/** How long saves keep landing in the same draft revision, from when it was started. */
export const EDIT_SESSION_MS = 10 * 60 * 1000;
const SHORT_ID_ATTEMPTS = 5;

const revisionDto = (revision: HelpRevisionRow) => ({
  id: revision.id,
  locale: revision.locale,
  title: revision.title,
  body: revision.bodyMd,
  kind: revision.kind,
  authorUserId: revision.authorUserId,
  createdAt: revision.createdAt,
});

export class HelpAuthoringService {
  private readonly now: () => Date;

  constructor(private readonly deps: HelpAuthoringDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async requireArticle(workspaceId: string, projectId: string, articleId: string): Promise<HelpArticleRow> {
    const article = await new HelpArticleRepo(this.deps.db).find(workspaceId, projectId, articleId);
    if (article === undefined) {
      throw new HelpNodeNotFoundError('article', articleId);
    }
    return article;
  }

  /** Whether a save by `actorUserId` may rewrite `draft` rather than add a revision. */
  private isOpenSession(article: HelpArticleRow, draft: HelpRevisionRow, actorUserId: string): boolean {
    return (
      draft.kind === RevisionKinds.sourceEdit &&
      draft.authorUserId === actorUserId &&
      draft.id !== article.publishedRevisionId &&
      this.now().getTime() - draft.createdAt.getTime() < EDIT_SESSION_MS
    );
  }

  private async writeRevision(
    article: HelpArticleRow,
    locale: string,
    input: { title: string; body: string; kind: RevisionKind; authorUserId: string | null },
  ) {
    const repo = new HelpArticleRepo(this.deps.db);
    const revision = await repo.insertRevision({
      workspaceId: article.workspaceId,
      articleId: article.id,
      locale,
      ...revisionText(input.title, input.body),
      kind: input.kind,
      authorUserId: input.authorUserId,
      // The service's clock, which the editing-session check compares against.
      createdAt: this.now(),
    });
    await repo.update(article.id, { draftRevisionId: revision.id });
    return revision;
  }

  private async insertWithShortId(
    row: Omit<Parameters<HelpArticleRepo['insert']>[0], 'shortId'>,
    attempt = 1,
  ): Promise<HelpArticleRow> {
    try {
      return await new HelpArticleRepo(this.deps.db).insert({ ...row, shortId: newShortId() });
    } catch (error) {
      if (error instanceof UniqueConstraintError && attempt < SHORT_ID_ATTEMPTS) {
        return await this.insertWithShortId(row, attempt + 1);
      }
      throw error;
    }
  }

  /** The whole site for the editor: every article with its draft title and state. */
  async tree(workspaceId: string, projectId: string) {
    await this.deps.sites.require(workspaceId, projectId);
    const treeRepo = new HelpTreeRepo(this.deps.db);
    const articleRepo = new HelpArticleRepo(this.deps.db);
    const collections = await treeRepo.collections(workspaceId, projectId);
    const sections = await treeRepo.sections(
      workspaceId,
      collections.map(collection => collection.id),
    );
    const articles = await articleRepo.inSections(
      workspaceId,
      sections.map(section => section.id),
    );
    const draftRevisions = await articleRepo.revisionsByIds(
      articles.flatMap(article => (article.draftRevisionId === null ? [] : [article.draftRevisionId])),
    );
    const drafts = new Map(draftRevisions.map(revision => [revision.id, revision]));
    return collections.map(collection => ({
      id: collection.id,
      slug: collection.slug,
      title: collection.title,
      description: collection.description,
      sections: sections
        .filter(section => section.collectionId === collection.id)
        .map(section => ({
          id: section.id,
          title: section.title,
          articles: articles
            .filter(article => article.sectionId === section.id)
            .map(article => ({
              id: article.id,
              shortId: article.shortId,
              slug: article.slug,
              status: article.status,
              title: drafts.get(article.draftRevisionId ?? '')?.title ?? '',
              hasUnpublishedChanges:
                article.draftRevisionId !== null && article.draftRevisionId !== article.publishedRevisionId,
            })),
        })),
    }));
  }

  async createCollection(workspaceId: string, projectId: string, input: CollectionInput) {
    await this.deps.sites.require(workspaceId, projectId);
    try {
      return await new HelpTreeRepo(this.deps.db).insertCollection({
        workspaceId,
        projectId,
        ...input,
        description: input.description ?? null,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new HelpSlugTakenError(input.slug, { cause: error });
      }
      throw error;
    }
  }

  async deleteCollection(workspaceId: string, projectId: string, collectionId: string): Promise<void> {
    if (!(await new HelpTreeRepo(this.deps.db).deleteCollection(workspaceId, projectId, collectionId))) {
      throw new HelpNodeNotFoundError('collection', collectionId);
    }
  }

  async createSection(workspaceId: string, projectId: string, input: SectionInput) {
    const repo = new HelpTreeRepo(this.deps.db);
    if ((await repo.findCollection(workspaceId, projectId, input.collectionId)) === undefined) {
      throw new HelpNodeNotFoundError('collection', input.collectionId);
    }
    return await repo.insertSection({ workspaceId, collectionId: input.collectionId, title: input.title });
  }

  async deleteSection(workspaceId: string, projectId: string, sectionId: string): Promise<void> {
    const repo = new HelpTreeRepo(this.deps.db);
    if ((await repo.findSection(workspaceId, projectId, sectionId)) === undefined) {
      throw new HelpNodeNotFoundError('section', sectionId);
    }
    await repo.deleteSection(workspaceId, sectionId);
  }

  /** A new draft article (empty body) at the end of its section. */
  async createArticle(workspaceId: string, projectId: string, actorUserId: string, input: ArticleCreateInput) {
    const site = await this.deps.sites.require(workspaceId, projectId);
    if ((await new HelpTreeRepo(this.deps.db).findSection(workspaceId, projectId, input.sectionId)) === undefined) {
      throw new HelpNodeNotFoundError('section', input.sectionId);
    }
    const article = await this.insertWithShortId({
      workspaceId,
      projectId,
      sectionId: input.sectionId,
      slug: input.slug ?? slugify(input.title),
      status: ArticleStatuses.draft,
    });
    await this.writeRevision(article, site.sourceLocale, {
      title: input.title,
      body: '',
      kind: RevisionKinds.sourceEdit,
      authorUserId: actorUserId,
    });
    return await this.article(workspaceId, projectId, article.id);
  }

  /** An article with its draft and, when published, the published text. */
  async article(workspaceId: string, projectId: string, articleId: string) {
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    const revisions = await new HelpArticleRepo(this.deps.db).revisionsByIds(
      [article.draftRevisionId, article.publishedRevisionId].filter(id => id !== null),
    );
    const byId = new Map(revisions.map(revision => [revision.id, revision]));
    const draft = byId.get(article.draftRevisionId ?? '');
    const published = byId.get(article.publishedRevisionId ?? '');
    return {
      id: article.id,
      shortId: article.shortId,
      slug: article.slug,
      sectionId: article.sectionId,
      status: article.status,
      publishedAt: article.publishedAt,
      draft: draft === undefined ? null : revisionDto(draft),
      published: published === undefined ? null : revisionDto(published),
    };
  }

  /** Save the draft as a new revision. The public site keeps the published text until publish. */
  /**
   * Save the article's text as its draft. Text equal to the draft's writes nothing; within
   * the author's editing session it rewrites the draft revision; otherwise it adds one.
   */
  async saveDraft(workspaceId: string, projectId: string, actorUserId: string, input: DraftInput) {
    const site = await this.deps.sites.require(workspaceId, projectId);
    const article = await this.requireArticle(workspaceId, projectId, input.articleId);
    const repo = new HelpArticleRepo(this.deps.db);
    const [draft] = article.draftRevisionId === null ? [] : await repo.revisionsByIds([article.draftRevisionId]);
    const contentHash = contentHashOf(input.title, input.body);
    const isSourceDraft = draft?.locale === site.sourceLocale;
    if (isSourceDraft && draft.contentHash === contentHash) {
      return await this.article(workspaceId, projectId, article.id);
    }
    if (isSourceDraft && this.isOpenSession(article, draft, actorUserId)) {
      await repo.updateRevisionText(workspaceId, draft.id, revisionText(input.title, input.body));
    } else {
      await this.writeRevision(article, site.sourceLocale, {
        title: input.title,
        body: input.body,
        kind: RevisionKinds.sourceEdit,
        authorUserId: actorUserId,
      });
    }
    return await this.article(workspaceId, projectId, article.id);
  }

  async publish(workspaceId: string, projectId: string, actorUserId: string, articleId: string) {
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    if (article.draftRevisionId === null) {
      throw new HelpNothingToPublishError(articleId);
    }
    await new HelpArticleRepo(this.deps.db).update(article.id, {
      status: ArticleStatuses.published,
      publishedRevisionId: article.draftRevisionId,
      publishedAt: this.now(),
      publishedByUserId: actorUserId,
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.helpArticlePublished,
      subjectType: 'help_article',
      subjectId: article.id,
      payload: { projectId, revisionId: article.draftRevisionId },
    });
    await this.deps.onPublished?.(workspaceId, projectId, article.id);
    await this.deps.onPublicChange?.(workspaceId, projectId, article);
    return await this.article(workspaceId, projectId, article.id);
  }

  /** Take the article off the public site; its text and history stay. */
  async unpublish(workspaceId: string, projectId: string, actorUserId: string, articleId: string) {
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    await new HelpArticleRepo(this.deps.db).update(article.id, { status: ArticleStatuses.draft });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.helpArticleUnpublished,
      subjectType: 'help_article',
      subjectId: article.id,
      payload: { projectId },
    });
    await this.deps.onPublicChange?.(workspaceId, projectId, article);
    return await this.article(workspaceId, projectId, article.id);
  }

  async deleteArticle(workspaceId: string, projectId: string, actorUserId: string, articleId: string) {
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    await new HelpArticleRepo(this.deps.db).delete(workspaceId, article.id);
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.helpArticleDeleted,
      subjectType: 'help_article',
      subjectId: article.id,
      payload: { projectId, shortId: article.shortId },
    });
    await this.deps.onPublicChange?.(workspaceId, projectId, article);
  }

  /** The article's source revisions, newest first. */
  async history(workspaceId: string, projectId: string, articleId: string) {
    const site = await this.deps.sites.require(workspaceId, projectId);
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    const revisions = await new HelpArticleRepo(this.deps.db).history(
      workspaceId,
      article.id,
      site.sourceLocale,
      HISTORY_LIMIT,
    );
    return revisions.map(revision => revisionDto(revision));
  }

  /** Make an old revision the draft again (as a new revision, so history stays append-only). */
  async restore(workspaceId: string, projectId: string, actorUserId: string, articleId: string, revisionId: string) {
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    const revision = await new HelpArticleRepo(this.deps.db).findRevision(workspaceId, revisionId);
    if (revision?.articleId !== article.id) {
      throw new HelpNodeNotFoundError('revision', revisionId);
    }
    await this.writeRevision(article, revision.locale, {
      title: revision.title,
      body: revision.bodyMd,
      kind: RevisionKinds.restore,
      authorUserId: actorUserId,
    });
    return await this.article(workspaceId, projectId, article.id);
  }
}
