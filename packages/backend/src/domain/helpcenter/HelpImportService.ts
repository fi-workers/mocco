// Importing a help center (#96) from another tool's export, such as Mintlify's: the
// bundle's collections, sections and articles are matched to what the site already has
// (collections by slug, sections by title, articles by their old path), so importing
// again updates rather than duplicates. Each old path is kept as a redirect. Images go
// to storage first (HelpImageService), and the bundle refers to their public URLs.

import { ArticleStatuses, RevisionKinds } from '@mocco/common/help';

import { contentHashOf, newShortId, revisionText } from '@backend/domain/helpcenter/content';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { HelpTreeRepo } from '@backend/domain/helpcenter/repos/tree.repo';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { HelpAuthoringService } from '@backend/domain/helpcenter/HelpAuthoringService';
import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { HelpArticleRow } from '@backend/domain/helpcenter/repos/article.repo';
import type { Db } from '@backend/infra/db/types';
import type { ImportBundle } from '@mocco/common/help-import';

export interface HelpImportDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  sites: Pick<HelpSiteService, 'require'>;
  authoring: Pick<HelpAuthoringService, 'publish'>;
}

const SHORT_ID_ATTEMPTS = 5;

export class HelpImportService {
  constructor(private readonly deps: HelpImportDeps) {}

  private async insertArticle(
    row: Omit<Parameters<HelpArticleRepo['insert']>[0], 'shortId'>,
    attempt = 1,
  ): Promise<HelpArticleRow> {
    try {
      return await new HelpArticleRepo(this.deps.db).insert({ ...row, shortId: newShortId() });
    } catch (error) {
      if (error instanceof UniqueConstraintError && attempt < SHORT_ID_ATTEMPTS) {
        return await this.insertArticle(row, attempt + 1);
      }
      throw error;
    }
  }

  /** One article of the bundle: created, or a new revision when its text changed. */
  private async importArticle(
    target: { workspaceId: string; projectId: string; sectionId: string; locale: string; actorUserId: string },
    input: ImportBundle['collections'][number]['sections'][number]['articles'][number],
  ): Promise<{ article: HelpArticleRow; outcome: 'created' | 'updated' | 'unchanged' }> {
    const { workspaceId, projectId, sectionId } = target;
    const repo = new HelpArticleRepo(this.deps.db);
    const redirect = await repo.findRedirect(projectId, input.fromPath);
    const existing = redirect === undefined ? undefined : await repo.find(workspaceId, projectId, redirect.articleId);
    const article =
      existing ??
      (await this.insertArticle({
        workspaceId,
        projectId,
        sectionId,
        slug: input.slug,
        status: ArticleStatuses.draft,
      }));
    if (existing === undefined) {
      await repo.insertRedirect({ workspaceId, projectId, fromPath: input.fromPath, articleId: article.id });
    }
    const [draft] = article.draftRevisionId === null ? [] : await repo.revisionsByIds([article.draftRevisionId]);
    const contentHash = contentHashOf(input.title, input.body);
    if (draft?.contentHash === contentHash) {
      return { article, outcome: 'unchanged' };
    }
    const revision = await repo.insertRevision({
      workspaceId,
      articleId: article.id,
      locale: target.locale,
      ...revisionText(input.title, input.body),
      kind: RevisionKinds.import,
      authorUserId: target.actorUserId,
    });
    await repo.update(article.id, { draftRevisionId: revision.id, sectionId });
    return { article, outcome: existing === undefined ? 'created' : 'updated' };
  }

  /**
   * Import a bundle. New articles are created; articles imported before (same old path)
   * get a new revision only when their text changed. With `publish`, every imported
   * article's draft is published.
   */
  async importBundle(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    bundle: ImportBundle,
    opts: { publish: boolean },
  ) {
    const site = await this.deps.sites.require(workspaceId, projectId);
    const treeRepo = new HelpTreeRepo(this.deps.db);
    const counts = { created: 0, updated: 0, unchanged: 0 };
    const touched: HelpArticleRow[] = [];
    /* eslint-disable no-await-in-loop, no-restricted-syntax -- one at a time: new collections, sections and articles take positions in the bundle's order */
    for (const collectionInput of bundle.collections) {
      const collection =
        (await treeRepo.findCollectionBySlug(workspaceId, projectId, collectionInput.slug)) ??
        (await treeRepo.insertCollection({
          workspaceId,
          projectId,
          slug: collectionInput.slug,
          title: collectionInput.title,
          description: null,
        }));
      for (const sectionInput of collectionInput.sections) {
        const section =
          (await treeRepo.findSectionByTitle(workspaceId, collection.id, sectionInput.title)) ??
          (await treeRepo.insertSection({ workspaceId, collectionId: collection.id, title: sectionInput.title }));
        const target = { workspaceId, projectId, sectionId: section.id, locale: site.sourceLocale, actorUserId };
        for (const input of sectionInput.articles) {
          const { article, outcome } = await this.importArticle(target, input);
          counts[outcome] += 1;
          touched.push(article);
        }
      }
    }
    /* eslint-enable no-await-in-loop, no-restricted-syntax */
    if (opts.publish) {
      await Promise.all(
        touched.map(
          async article => await this.deps.authoring.publish(workspaceId, projectId, actorUserId, article.id),
        ),
      );
    }
    return counts;
  }
}
