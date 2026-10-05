// `mocco_help_articles_*` — what a project's help center publishes: find articles by
// text (or list them all) and read one, in a language where it is translated. Read-only
// and published content only, the same content the public site and `/v1/help` serve:
// drafts and unpublished articles are not there. Writing, publishing and translating are
// the console's, and a tool that does them needs its own design pass.
//
// Thin adapters (ADR 0025) over `HelpPublicReadService`, the service the public site and
// `/v1/help` read through. The help center is project-scoped, so every call first goes
// through `ProjectScope` — membership, the help center product, the project in that
// workspace — with the caller's own id, and the service then reads only that project's
// site. The paging here only narrows what the service returned; it decides nothing.
import { helpV1LocaleSchema } from '@mocco/common/help-v1';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { HelpNodeNotFoundError } from '@backend/domain/helpcenter/errors';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { McpServer } from '@modelcontextprotocol/server';

export interface HelpToolDeps {
  helpPublic: Pick<HelpPublicReadService, 'searchInProject' | 'siteInProject' | 'articleInProject'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** The most a search ranks; the service caps a public search the same way. */
const MAX_SEARCH_HITS = 20;
/** How much of an article a concise read shows. */
const EXCERPT_CHARS = 600;

const projectArg = z
  .uuid()
  .optional()
  .describe('The project the help center belongs to. Omit it when the workspace has exactly one.');

const localeArg = helpV1LocaleSchema
  .optional()
  .describe(
    "The reader's language as a tag (`en`, `ko-KR`). An article not translated into it is in the source language; the answer's `locale` says which. Omit it for the source language.",
  );

const responseFormatArg = (concise: string, detailed: string) =>
  z.enum(['concise', 'detailed']).default('concise').describe(`\`concise\` is ${concise}; \`detailed\` ${detailed}.`);

const searchInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Text to find in titles and article text (case-insensitive, any script). Omit it to list every published article in order.',
    ),
  match: z
    .enum(['all', 'any'])
    .default('all')
    .describe(
      '`all`: every word must appear. `any`: one is enough, more rank higher — for free text such as a customer question.',
    ),
  locale: localeArg,
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  after: z.string().optional().describe("Cursor, when listing without a query: the previous page's `nextAfter`."),
  responseFormat: responseFormatArg(
    'each article’s id, title and path',
    'adds its collection and section, and with a query the text around the match',
  ),
});

const readInput = z.object({
  articleId: z
    .string()
    .regex(/^[a-z0-9]{6}(?:-[a-z0-9-]{0,80})?$/u)
    .describe('The article id (6 characters), or the `{id}-{slug}` from its path, as the search returns it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
  locale: localeArg,
  responseFormat: responseFormatArg(
    `the title, language, dates and the first ${EXCERPT_CHARS} characters of the Markdown`,
    'the whole Markdown',
  ),
});

export type SearchHelpArticlesArgs = z.infer<typeof searchInput>;
export type GetHelpArticleArgs = z.infer<typeof readInput>;

const resolveHelpProject = async (deps: HelpToolDeps, userId: string, asked: Partial<ProjectInScope>) =>
  await deps.projects.resolve(userId, asked, Products.helpcenter);

/** An article's id from its public path (`/{locale}/articles/{id}-{slug}`). */
const idOfPath = (path: string) => /\/articles\/([a-z0-9]{6})/u.exec(path)?.[1] ?? null;

export async function searchHelpArticles(deps: HelpToolDeps, args: SearchHelpArticlesArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const isDetailed = args.responseFormat === 'detailed';
  const site = await deps.helpPublic.siteInProject(scope.workspaceId, scope.projectId, args.locale ?? '');
  const entries = site.tree.collections.flatMap(collection =>
    collection.sections.flatMap(section =>
      section.articles.map(article => ({
        id: article.shortId,
        title: article.title,
        path: article.path,
        ...(isDetailed && { collection: collection.title, section: section.title }),
      })),
    ),
  );
  if (args.query === undefined) {
    const start = args.after === undefined ? 0 : entries.findIndex(entry => entry.id === args.after) + 1;
    const page = entries.slice(start, start + args.limit);
    return {
      site: site.name,
      locale: site.tree.locale,
      articles: page,
      // Present when there is more: pass it back as `after`.
      ...(start + page.length < entries.length && { nextAfter: page.at(-1)?.id }),
    };
  }
  const found = await deps.helpPublic.searchInProject(
    scope.workspaceId,
    scope.projectId,
    args.locale ?? '',
    args.query,
    Math.min(args.limit, MAX_SEARCH_HITS),
    args.match,
  );
  return {
    site: site.name,
    locale: found.locale,
    articles: found.hits.map(hit => {
      const id = idOfPath(hit.path);
      const entry = entries.find(candidate => candidate.id === id);
      return {
        id,
        title: hit.title,
        path: hit.path,
        ...(isDetailed && {
          ...(entry !== undefined && 'collection' in entry && { collection: entry.collection, section: entry.section }),
          snippet: hit.snippet,
        }),
      };
    }),
  };
}

export async function getHelpArticle(deps: HelpToolDeps, args: GetHelpArticleArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const { article } = await deps.helpPublic.articleInProject(
    scope.workspaceId,
    scope.projectId,
    args.locale ?? '',
    args.articleId,
  );
  if (article === undefined) {
    throw new HelpNodeNotFoundError('article', args.articleId);
  }
  const isDetailed = args.responseFormat === 'detailed';
  const isCut = !isDetailed && article.body.length > EXCERPT_CHARS;
  return {
    id: article.shortId,
    slug: article.slug,
    title: article.title,
    locale: article.locale,
    locales: article.locales,
    path: article.canonicalPath,
    publishedAt: article.publishedAt,
    updatedAt: article.modifiedAt,
    body: isCut ? `${article.body.slice(0, EXCERPT_CHARS)}…` : article.body,
    ...(isCut && { isTruncated: true }),
  };
}

export function registerHelpTools(server: McpServer, deps: HelpToolDeps): void {
  server.registerTool(
    'mocco_help_articles_search',
    {
      title: 'Find help articles',
      description:
        "A project's published help center articles: those matching a text (best first), or every one in order without it, in the asked language where translated. Drafts and unpublished articles are not included. Read-only.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchHelpArticles(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_help_articles_get',
    {
      title: 'Read a help article',
      description:
        'One published help center article as Markdown, in the asked language where translated (else the source language; `locale` says which), with the languages it is published in. Read-only.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getHelpArticle(deps, args, userIdOf(ctx))),
  );
}
