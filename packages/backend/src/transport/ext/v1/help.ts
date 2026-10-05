// /v1/help (#96, #216): read a project's published help center from an app — search it
// (e.g. to suggest articles on a contact screen), list its collections and show an
// article. Read-only and published content only, so publishable keys may call it (scope
// help:read). Every answer says which language it is in, and carries a weak ETag
// (If-None-Match → 304).
import { createHash } from 'node:crypto';

import { ApiScopes } from '@mocco/common/apikey';
import {
  helpV1ArticleRefSchema,
  helpV1ArticleSchema,
  helpV1CollectionResultSchema,
  helpV1FeedbackInputSchema,
  helpV1FeedbackResultSchema,
  helpV1LocaleQuerySchema,
  helpV1SearchQuerySchema,
  helpV1SearchResultSchema,
  helpV1SiteSchema,
} from '@mocco/common/help-v1';
import { Hono } from 'hono';

import { HELP_FEEDBACK_RATE_LIMIT } from '@backend/domain/helpcenter/HelpFeedbackService';
import { clientAddressOf, ipBucketOf, limit, requireKey } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { HelpFeedbackService } from '@backend/domain/helpcenter/HelpFeedbackService';
import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';
import type { Context } from 'hono';
import type { z } from 'zod';

export interface HelpServingDeps {
  help: Pick<HelpPublicReadService, 'searchInProject' | 'siteInProject' | 'articleInProject'>;
  feedback: Pick<HelpFeedbackService, 'recordInProject'>;
  /** The site's public origin, for absolute article URLs; null when not served. */
  originOf: (slug: string) => string | null;
}

/** Published content changes within a minute on the public site too. */
const CACHE_CONTROL = 'public, max-age=60';

const noHelpCenter = () => problemResponse(problemOf(404, ProblemCodes.notFound, 'This project has no help center'));

const isMissingSite = (error: unknown) => error instanceof Error && error.name === 'HelpSiteNotFoundError';

/** The entity tags an `If-None-Match` header lists, weak or not. */
const heldEtags = (header: string | undefined): string[] =>
  (header ?? '')
    .split(',')
    // eslint-disable-next-line sonarjs/null-dereference -- split() yields strings, never null
    .map(tag => tag.trim().replace(/^W\//u, ''))
    .filter(tag => tag !== '');

/** Answer `body` narrowed by `schema`, with a weak ETag over it; 304 when the caller holds it. */
function answer<S extends z.ZodType>(c: Context<V1Env>, schema: S, body: z.input<S>): Response {
  const narrowed = schema.parse(body);
  const json = JSON.stringify(narrowed);
  const tag = `"${createHash('sha256').update(json).digest('base64url').slice(0, 27)}"`;
  const headers = { ETag: `W/${tag}`, 'Cache-Control': CACHE_CONTROL };
  const held = heldEtags(c.req.header('if-none-match'));
  if (held.includes(tag) || held.includes('*')) {
    return c.body(null, 304, headers);
  }
  return c.body(json, 200, { ...headers, 'Content-Type': 'application/json' });
}

type PublishedCollection = Awaited<ReturnType<HelpPublicReadService['tree']>>['collections'][number];

/** The tree's collections as /v1 shows them: each article by its short id, with its address. */
const withUrls = (collections: PublishedCollection[], urlOf: (path: string) => string | null) =>
  collections.map(collection => ({
    ...collection,
    sections: collection.sections.map(section => ({
      title: section.title,
      articles: section.articles.map(article => ({
        id: article.shortId,
        slug: article.slug,
        title: article.title,
        path: article.path,
        url: urlOf(article.path),
      })),
    })),
  }));

export function createHelpRoutes(deps: V1Deps, help: HelpServingDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();
  const read = requireKey(deps, { scope: ApiScopes.helpRead });
  const urlOf = (slug: string, path: string) => {
    const origin = help.originOf(slug);
    return origin === null ? null : `${origin}${path}`;
  };

  app.get('/search', read, async c => {
    const query = helpV1SearchQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return problemResponse(problemOf(400, ProblemCodes.badRequest, 'q is required (1–500 characters)'));
    }
    const { workspaceId, projectId } = c.var.principal;
    try {
      const result = await help.help.searchInProject(
        workspaceId,
        projectId,
        query.data.locale ?? '',
        query.data.q,
        query.data.limit,
        query.data.match,
      );
      return answer(c, helpV1SearchResultSchema, {
        locale: result.locale,
        hits: result.hits.map(hit => ({ ...hit, url: urlOf(result.slug, hit.path) })),
      });
    } catch (error) {
      if (isMissingSite(error)) {
        return noHelpCenter();
      }
      throw error;
    }
  });

  /** The site, its languages and what it publishes in the asked language. */
  const loadSite = async (c: Context<V1Env>) => {
    const query = helpV1LocaleQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return { refused: problemResponse(problemOf(400, ProblemCodes.badRequest, 'locale is not a language tag')) };
    }
    const { workspaceId, projectId } = c.var.principal;
    try {
      const site = await help.help.siteInProject(workspaceId, projectId, query.data.locale ?? '');
      return {
        site: {
          name: site.name,
          sourceLocale: site.sourceLocale,
          locales: site.locales,
          locale: site.tree.locale,
          url: urlOf(site.slug, `/${site.tree.locale}`),
          collections: withUrls(site.tree.collections, path => urlOf(site.slug, path)),
        },
      };
    } catch (error) {
      if (isMissingSite(error)) {
        return { refused: noHelpCenter() };
      }
      throw error;
    }
  };

  app.get('/site', read, async c => {
    const loaded = await loadSite(c);
    return loaded.site === undefined ? loaded.refused : answer(c, helpV1SiteSchema, loaded.site);
  });

  app.get('/collections/:slug', read, async c => {
    const loaded = await loadSite(c);
    if (loaded.site === undefined) {
      return loaded.refused;
    }
    const collection = loaded.site.collections.find(candidate => candidate.slug === c.req.param('slug'));
    if (collection === undefined) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'No such published collection'));
    }
    return answer(c, helpV1CollectionResultSchema, { locale: loaded.site.locale, collection });
  });

  app.get('/articles/:ref', read, async c => {
    const query = helpV1LocaleQuerySchema.safeParse(c.req.query());
    const ref = helpV1ArticleRefSchema.safeParse(c.req.param('ref'));
    if (!query.success || !ref.success) {
      return problemResponse(
        problemOf(
          400,
          ProblemCodes.badRequest,
          'Use the article id ({shortId} or {shortId}-{slug}) and a language tag',
        ),
      );
    }
    const { workspaceId, projectId } = c.var.principal;
    try {
      const { slug, article } = await help.help.articleInProject(
        workspaceId,
        projectId,
        query.data.locale ?? '',
        ref.data,
      );
      if (article === undefined) {
        return problemResponse(problemOf(404, ProblemCodes.notFound, 'No such published article'));
      }
      return answer(c, helpV1ArticleSchema, {
        id: article.shortId,
        slug: article.slug,
        locale: article.locale,
        title: article.title,
        body: article.body,
        path: article.canonicalPath,
        url: urlOf(slug, article.canonicalPath),
        locales: article.locales,
        publishedAt: article.publishedAt?.toISOString() ?? null,
        updatedAt: article.modifiedAt?.toISOString() ?? null,
      });
    } catch (error) {
      if (isMissingSite(error)) {
        return noHelpCenter();
      }
      throw error;
    }
  });

  app.post('/articles/:ref/feedback', read, async c => {
    const ref = helpV1ArticleRefSchema.safeParse(c.req.param('ref'));
    let raw: unknown = null;
    try {
      raw = await c.req.json();
    } catch {
      // Not JSON: refused below.
    }
    const body = helpV1FeedbackInputSchema.safeParse(raw);
    if (!ref.success || !body.success) {
      return problemResponse(
        problemOf(400, ProblemCodes.badRequest, 'Send { helpful } (and optionally locale, comment, visitorId)'),
      );
    }
    const limited = await limit(deps, `help-feedback:${ipBucketOf(c)}`, HELP_FEEDBACK_RATE_LIMIT);
    if (limited.refused !== undefined) {
      return limited.refused;
    }
    const { workspaceId, projectId } = c.var.principal;
    const { visitorId, helpful, locale, comment } = body.data;
    try {
      const result = await help.feedback.recordInProject(
        workspaceId,
        projectId,
        ref.data,
        { helpful, ...(locale !== undefined && { locale }), ...(comment !== undefined && { comment }) },
        visitorId === undefined
          ? { network: { address: clientAddressOf(c), userAgent: c.req.header('user-agent') ?? '' } }
          : { visitorId },
      );
      return c.json(helpV1FeedbackResultSchema.parse(result), 201);
    } catch (error) {
      if (isMissingSite(error)) {
        return noHelpCenter();
      }
      if (error instanceof Error && error.name === 'HelpNodeNotFoundError') {
        return problemResponse(problemOf(404, ProblemCodes.notFound, 'No such published article'));
      }
      throw error;
    }
  });

  return app;
}
