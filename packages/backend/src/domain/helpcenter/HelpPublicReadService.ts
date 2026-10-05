// What a help center shows the public (#96): published articles only, looked up by the
// site's slug, in the asked language when it has one and in the source language
// otherwise. The public pages and /v1 call this; nothing here needs a session.

import { articlePath, ArticleStatuses } from '@mocco/common/help';

import { HelpSiteNotFoundError } from '@backend/domain/helpcenter/errors';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { HelpNodeTranslationRepo } from '@backend/domain/helpcenter/repos/node-translation.repo';
import { HelpSiteRepo } from '@backend/domain/helpcenter/repos/site.repo';
import { HelpTranslationRepo } from '@backend/domain/helpcenter/repos/translation.repo';
import { HelpTreeRepo } from '@backend/domain/helpcenter/repos/tree.repo';
import { type SearchMatch, searchArticles } from '@backend/domain/helpcenter/search';

import type { HelpSiteRow } from '@backend/domain/helpcenter/repos/site.repo';
import type { Db } from '@backend/infra/db/types';

/** `{shortId}-{slug}` or just `{shortId}`, as the article URL carries it. */
/** The language to serve: the asked one when the site has it, else the source. */
const localeFor = (site: HelpSiteRow, locale: string): string =>
  locale === site.sourceLocale || site.locales.includes(locale) ? locale : site.sourceLocale;

const ARTICLE_REF = /^([a-z0-9]{6})(?:-[a-z0-9-]*)?$/u;

export class HelpPublicReadService {
  constructor(private readonly deps: { db: Db }) {}

  private async requireSite(slug: string): Promise<HelpSiteRow & { name: string }> {
    const site = await new HelpSiteRepo(this.deps.db).findBySlug(slug);
    if (site === undefined) {
      throw new HelpSiteNotFoundError(slug);
    }
    return site;
  }

  /** The slug of a project's help site: the /v1 surface, where a key names the project. */
  private async slugInProject(workspaceId: string, projectId: string): Promise<string> {
    const site = await new HelpSiteRepo(this.deps.db).find(workspaceId, projectId);
    if (site === undefined) {
      throw new HelpSiteNotFoundError(`project ${projectId}`);
    }
    return site.slug;
  }

  /** Translated titles of these articles in `locale`, by article id. */
  private async translatedTitles(articleIds: readonly string[], locale: string): Promise<Map<string, string>> {
    const rows = await new HelpTranslationRepo(this.deps.db).withText(articleIds, locale);
    const revisions = await new HelpArticleRepo(this.deps.db).revisionsByIds(rows.map(row => row.revisionId ?? ''));
    const byId = new Map(revisions.map(revision => [revision.id, revision.title]));
    return new Map(
      rows.flatMap(row => {
        const title = byId.get(row.revisionId ?? '');
        return title === undefined ? [] : [[row.articleId, title] as const];
      }),
    );
  }

  private async translationText(workspaceId: string, articleId: string, locale: string) {
    const row = await new HelpTranslationRepo(this.deps.db).find(workspaceId, articleId, locale);
    if (row?.revisionId === null || row === undefined) {
      return undefined;
    }
    const [revision] = await new HelpArticleRepo(this.deps.db).revisionsByIds([row.revisionId]);
    return revision;
  }

  /** Translated texts of these articles in `locale`, by article id. */
  private async translationTexts(articleIds: readonly string[], locale: string) {
    const rows = await new HelpTranslationRepo(this.deps.db).withText(articleIds, locale);
    const revisions = await new HelpArticleRepo(this.deps.db).revisionsByIds(rows.map(row => row.revisionId ?? ''));
    const byId = new Map(revisions.map(revision => [revision.id, revision]));
    return new Map(
      rows.flatMap(row => {
        const revision = byId.get(row.revisionId ?? '');
        return revision === undefined ? [] : [[row.articleId, revision] as const];
      }),
    );
  }

  /** The site's collections and sections, and its articles that have something published. */
  private async publishedTree(site: HelpSiteRow) {
    const treeRepo = new HelpTreeRepo(this.deps.db);
    const collections = await treeRepo.collections(site.workspaceId, site.projectId);
    const sections = await treeRepo.sections(
      site.workspaceId,
      collections.map(collection => collection.id),
    );
    const inSections = await new HelpArticleRepo(this.deps.db).inSections(
      site.workspaceId,
      sections.map(section => section.id),
    );
    const articles = inSections.filter(
      article => article.status === ArticleStatuses.published && article.publishedRevisionId !== null,
    );
    return { collections, sections, articles };
  }

  async site(slug: string) {
    const site = await this.requireSite(slug);
    return {
      slug: site.slug,
      name: site.name,
      sourceLocale: site.sourceLocale,
      locales: site.locales,
      allowAiTraining: site.allowAiTraining,
    };
  }

  /** The published tree in `locale`: collections, sections and articles with something published. */
  async tree(slug: string, locale: string) {
    const site = await this.requireSite(slug);
    const served = localeFor(site, locale);
    const articleRepo = new HelpArticleRepo(this.deps.db);
    const { collections, sections, articles } = await this.publishedTree(site);
    const published = await articleRepo.revisionsByIds(articles.map(article => article.publishedRevisionId ?? ''));
    const titles = new Map(published.map(revision => [revision.id, revision.title]));
    // In another language: the translated title where there is a translation, else the source's.
    const translated =
      served === site.sourceLocale
        ? new Map<string, string>()
        : await this.translatedTitles(
            articles.map(article => article.id),
            served,
          );
    const nodeTitles =
      served === site.sourceLocale
        ? []
        : await new HelpNodeTranslationRepo(this.deps.db).inLocale(site.workspaceId, served, {
            collectionIds: collections.map(collection => collection.id),
            sectionIds: sections.map(section => section.id),
          });
    const collectionTitle = (id: string, fallback: string) =>
      nodeTitles.find(row => row.collectionId === id)?.title ?? fallback;
    const sectionTitle = (id: string, fallback: string) =>
      nodeTitles.find(row => row.sectionId === id)?.title ?? fallback;
    return {
      locale: served,
      collections: collections
        .map(collection => ({
          slug: collection.slug,
          title: collectionTitle(collection.id, collection.title),
          description: collection.description,
          sections: sections
            .filter(section => section.collectionId === collection.id)
            .map(section => ({
              title: sectionTitle(section.id, section.title),
              articles: articles
                .filter(article => article.sectionId === section.id)
                .map(article => {
                  const title = translated.get(article.id);
                  return {
                    shortId: article.shortId,
                    slug: article.slug,
                    title: title ?? titles.get(article.publishedRevisionId ?? '') ?? '',
                    path: articlePath(title === undefined ? site.sourceLocale : served, article.shortId, article.slug),
                  };
                }),
            }))
            .filter(section => section.articles.length > 0),
        }))
        .filter(collection => collection.sections.length > 0),
    };
  }

  /**
   * Every public page of a site, for its sitemap: each language's home, and each published
   * article in the languages it is really served in — the source, and every language with a
   * translation (any other language redirects to the source's address). `lastModified` is
   * when that language's text last changed; a home has none.
   */
  async sitemap(slug: string) {
    const site = await this.requireSite(slug);
    const { articles } = await this.publishedTree(site);
    const ids = articles.map(article => article.id);
    const translated = await Promise.all(
      site.locales.map(async locale => ({ locale, texts: await this.translationTexts(ids, locale) })),
    );
    return {
      sourceLocale: site.sourceLocale,
      homes: [site.sourceLocale, ...site.locales].map(locale => ({ locale, path: `/${locale}` })),
      articles: articles.map(article => [
        {
          locale: site.sourceLocale,
          path: articlePath(site.sourceLocale, article.shortId, article.slug),
          lastModified: article.publishedAt,
        },
        ...translated.flatMap(({ locale, texts }) => {
          const text = texts.get(article.id);
          return text === undefined
            ? []
            : [{ locale, path: articlePath(locale, article.shortId, article.slug), lastModified: text.createdAt }];
        }),
      ]),
    };
  }

  /**
   * A published article by its URL ref (`{shortId}-{slug}`). Undefined when there is no
   * such published article. `canonicalPath` differs from the asked one when the slug
   * changed or the language fell back, so the page can redirect.
   */
  async article(slug: string, locale: string, ref: string) {
    const site = await this.requireSite(slug);
    const shortId = ARTICLE_REF.exec(ref)?.[1];
    if (shortId === undefined) {
      return undefined;
    }
    const repo = new HelpArticleRepo(this.deps.db);
    const article = await repo.findByShortId(site.projectId, shortId);
    if (article?.status !== ArticleStatuses.published || article.publishedRevisionId === null) {
      return undefined;
    }
    const [revision] = await repo.revisionsByIds([article.publishedRevisionId]);
    if (revision === undefined) {
      return undefined;
    }
    const wanted = localeFor(site, locale);
    // Another language: its translation, else the source (and the source's address).
    const translation =
      wanted === site.sourceLocale ? undefined : await this.translationText(site.workspaceId, article.id, wanted);
    const served = translation === undefined ? site.sourceLocale : wanted;
    // The languages this article is really served in: the source and each translated one.
    const translated = await Promise.all(
      site.locales.map(async offered => {
        const texts = await this.translationTexts([article.id], offered);
        return texts.size > 0 ? [offered] : [];
      }),
    );
    return {
      shortId: article.shortId,
      slug: article.slug,
      locale: served,
      title: translation?.title ?? revision.title,
      body: translation?.bodyMd ?? revision.bodyMd,
      publishedAt: article.publishedAt,
      // When this page last changed: the last publish, or a later translation of it.
      modifiedAt:
        translation !== undefined && (article.publishedAt === null || translation.createdAt > article.publishedAt)
          ? translation.createdAt
          : article.publishedAt,
      locales: [site.sourceLocale, ...translated.flat()],
      canonicalPath: articlePath(served, article.shortId, article.slug),
    };
  }

  /**
   * Everything a site publishes in `locale`, text included, for agents (llms.txt and
   * llms-full.txt): its collections, sections and articles in order, each article in the
   * asked language where translated, else the source (at the source's address).
   */
  async forAgents(slug: string, locale: string) {
    const site = await this.requireSite(slug);
    const tree = await this.tree(slug, locale);
    const { articles } = await this.publishedTree(site);
    const sources = await new HelpArticleRepo(this.deps.db).revisionsByIds(
      articles.map(article => article.publishedRevisionId ?? ''),
    );
    const sourceById = new Map(sources.map(revision => [revision.id, revision]));
    const translations =
      tree.locale === site.sourceLocale
        ? new Map<string, { bodyMd: string }>()
        : await this.translationTexts(
            articles.map(article => article.id),
            tree.locale,
          );
    // The tree already holds each article's title and address in the language it is served in.
    const bodyOf = (shortId: string) => {
      const article = articles.find(candidate => candidate.shortId === shortId);
      if (article === undefined) {
        return '';
      }
      return (translations.get(article.id) ?? sourceById.get(article.publishedRevisionId ?? ''))?.bodyMd ?? '';
    };
    return {
      name: site.name,
      locale: tree.locale,
      collections: tree.collections.map(collection => ({
        title: collection.title,
        sections: collection.sections.map(section => ({
          title: section.title,
          articles: section.articles.map(entry => ({
            title: entry.title,
            path: entry.path,
            body: bodyOf(entry.shortId),
          })),
        })),
      })),
    };
  }

  /**
   * Published articles matching `query`, in `locale` where translated (else the source),
   * best first: every term must appear in the title or the text, or with `any`, one of them.
   */
  async search(slug: string, locale: string, query: string, limit = 10, match: SearchMatch = 'all') {
    const site = await this.requireSite(slug);
    const served = localeFor(site, locale);
    const articleRepo = new HelpArticleRepo(this.deps.db);
    const { articles } = await this.publishedTree(site);
    const sources = await articleRepo.revisionsByIds(articles.map(article => article.publishedRevisionId ?? ''));
    const sourceById = new Map(sources.map(revision => [revision.id, revision]));
    const translations =
      served === site.sourceLocale
        ? new Map<string, { title: string; bodyMd: string }>()
        : await this.translationTexts(
            articles.map(article => article.id),
            served,
          );
    const searchable = articles.flatMap(article => {
      const translated = translations.get(article.id);
      const text = translated ?? sourceById.get(article.publishedRevisionId ?? '');
      if (text === undefined) {
        return [];
      }
      const textLocale = translated === undefined ? site.sourceLocale : served;
      return [{ title: text.title, body: text.bodyMd, path: articlePath(textLocale, article.shortId, article.slug) }];
    });
    return { locale: served, hits: searchArticles(searchable, query, limit, match) };
  }

  /** Search the help center of a project (the /v1 surface, where a key names the project). */
  async searchInProject(
    workspaceId: string,
    projectId: string,
    locale: string,
    query: string,
    limit = 10,
    match: SearchMatch = 'all',
  ) {
    const slug = await this.slugInProject(workspaceId, projectId);
    return { slug, ...(await this.search(slug, locale, query, limit, match)) };
  }

  /** A project's help site and its published tree in `locale` (the /v1 surface). */
  async siteInProject(workspaceId: string, projectId: string, locale: string) {
    const slug = await this.slugInProject(workspaceId, projectId);
    return { ...(await this.site(slug)), tree: await this.tree(slug, locale) };
  }

  /** A published article of a project's help site by its ref, or undefined (the /v1 surface). */
  async articleInProject(workspaceId: string, projectId: string, locale: string, ref: string) {
    const slug = await this.slugInProject(workspaceId, projectId);
    return { slug, article: await this.article(slug, locale, ref) };
  }

  /** Where an old path (an imported site's URL) now lives, or undefined. */
  async redirect(slug: string, fromPath: string): Promise<string | undefined> {
    const site = await this.requireSite(slug);
    const repo = new HelpArticleRepo(this.deps.db);
    const redirect = await repo.findRedirect(site.projectId, fromPath);
    if (redirect === undefined) {
      return undefined;
    }
    const article = await repo.find(site.workspaceId, site.projectId, redirect.articleId);
    return article === undefined ? undefined : articlePath(site.sourceLocale, article.shortId, article.slug);
  }
}
