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
//
// `mocco_help_glossary_list` reads the glossary the translations follow (#214), over
// `HelpGlossaryService.list`. Accepting a draft, translating again and changing the glossary
// are the changing tools in `help-write.ts` (#480).
import {
  GlossaryRules,
  HELP_LOCALES,
  helpLocaleSchema,
  SegmentChanges,
  translationFilterSchema,
  TranslationFilters,
} from '@mocco/common/help';
import { helpV1LocaleSchema } from '@mocco/common/help-v1';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { HelpNodeNotFoundError } from '@backend/domain/helpcenter/errors';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { HelpFeedbackService } from '@backend/domain/helpcenter/HelpFeedbackService';
import type { HelpGlossaryService } from '@backend/domain/helpcenter/HelpGlossaryService';
import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import type { HelpTranslationService } from '@backend/domain/helpcenter/HelpTranslationService';
import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { McpServer } from '@modelcontextprotocol/server';

export interface HelpToolDeps {
  helpPublic: Pick<HelpPublicReadService, 'searchInProject' | 'siteInProject' | 'articleInProject'>;
  /** "Was this helpful?" over the last 30 days: the console's read of the same answers. */
  helpFeedback: Pick<HelpFeedbackService, 'helpfulness'>;
  /** The translations dashboard and one language's review: the console's reads. */
  helpTranslations: Pick<HelpTranslationService, 'grid' | 'reviewByShortId'>;
  /** The glossary translations follow: the console's read. */
  helpGlossary: Pick<HelpGlossaryService, 'list'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_TRANSLATIONS_LIMIT = 20;
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
    `the title, language, dates, the first ${EXCERPT_CHARS} characters of the Markdown and readers' yes/no answers over the last 30 days`,
    'the whole Markdown and the newest comments readers left',
  ),
});

const translationsInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  filter: translationFilterSchema
    .default(TranslationFilters.attention)
    .describe(
      'Which articles to list: `attention` (the default: a language stale, failed or not translated), `stale`, `failed`, or `all`.',
    ),
  locales: z
    .array(helpLocaleSchema)
    .max(HELP_LOCALES.length)
    .optional()
    .describe(
      'Only these languages (`ko`, `ja`, …), for the counts, the columns and the filter. Omit for every offered one.',
    ),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_TRANSLATIONS_LIMIT),
  offset: z.number().int().min(0).default(0).describe("Paging: the previous answer's `nextOffset`, as it was given."),
  responseFormat: responseFormatArg(
    "per-language counts, and each listed article's id, title and a short status per language (`auto`, `reviewed`, `stale`, `failed`, …)",
    "adds each article's collection and section, and per language its state, whether it is stale, whether a machine draft waits, and the last error",
  ),
});

const translationInput = z.object({
  articleId: z
    .string()
    .regex(/^[a-z0-9]{6}(?:-[a-z0-9-]{0,80})?$/u)
    .describe(
      'The article id (6 characters), or the `{id}-{slug}` from its path, as `mocco_help_translations_list` returns it.',
    ),
  locale: helpLocaleSchema.describe('The language of the translation (`ko`, `ja`, …): one the help center offers.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    'its state, who reviewed it and when, whether a machine draft waits, and the source segments that changed since it was made',
    'adds the source, the translation and the machine draft as Markdown',
  ),
});

const glossaryInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Only terms containing this text (case-insensitive), in the term or a translation.'),
  rule: z
    .enum([GlossaryRules.keep, GlossaryRules.fixed])
    .optional()
    .describe('`keep`: terms kept as written in every language. `fixed`: terms with one translation per language.'),
  locale: helpLocaleSchema
    .optional()
    .describe('Only this language’s fixed translations (`ko`, `ja`, …); kept terms are listed either way.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_TRANSLATIONS_LIMIT),
  offset: z.number().int().min(0).default(0).describe("Paging: the previous answer's `nextOffset`, as it was given."),
  responseFormat: responseFormatArg(
    'each term, its rule and its fixed translations',
    "adds each term's id, note and when it last changed",
  ),
});

export type SearchHelpArticlesArgs = z.infer<typeof searchInput>;
export type GetHelpArticleArgs = z.infer<typeof readInput>;
export type ListHelpTranslationsArgs = z.infer<typeof translationsInput>;
export type GetHelpTranslationArgs = z.infer<typeof translationInput>;
export type ListHelpGlossaryArgs = z.infer<typeof glossaryInput>;

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
  const answers = await deps.helpFeedback.helpfulness(scope.workspaceId, scope.projectId, article.articleId);
  const total = answers.helpful + answers.notHelpful;
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
    // Counts and comment text only: who answered (the visitor hash) never leaves the service.
    helpfulness: {
      days: answers.days,
      helpful: answers.helpful,
      notHelpful: answers.notHelpful,
      share: total === 0 ? null : Math.round((answers.helpful / total) * 100) / 100,
      ...(isDetailed && {
        comments: answers.comments.map(entry => ({
          helpful: entry.helpful,
          comment: entry.comment,
          locale: entry.locale,
          createdAt: entry.createdAt,
        })),
      }),
    },
  };
}

/** A language's status in a few words: its state (`not_translated` without one), then `stale` and `draft` when they apply. */
const statusOf = (cell: { state: string | null; isStale: boolean; hasProposal: boolean }) =>
  [cell.state ?? 'not_translated', ...(cell.isStale ? ['stale'] : []), ...(cell.hasProposal ? ['draft'] : [])].join(
    ', ',
  );

export async function listHelpTranslations(deps: HelpToolDeps, args: ListHelpTranslationsArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const grid = await deps.helpTranslations.grid(scope.workspaceId, scope.projectId, {
    filter: args.filter,
    offset: args.offset,
    limit: args.limit,
    ...(args.locales !== undefined && { locales: args.locales }),
  });
  const isDetailed = args.responseFormat === 'detailed';
  return {
    sourceLocale: grid.sourceLocale,
    filter: grid.filter,
    counts: grid.counts,
    total: grid.total,
    articles: grid.articles.map(article => ({
      id: article.shortId,
      title: article.title,
      ...(isDetailed
        ? {
            collection: article.collection,
            section: article.section,
            languages: article.languages,
          }
        : { languages: Object.fromEntries(article.languages.map(cell => [cell.locale, statusOf(cell)])) }),
    })),
    // Present when there is more: pass it back as `offset`.
    ...(grid.nextOffset !== null && { nextOffset: grid.nextOffset }),
  };
}

export async function getHelpTranslation(deps: HelpToolDeps, args: GetHelpTranslationArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const [shortId = args.articleId] = args.articleId.split('-');
  const review = await deps.helpTranslations.reviewByShortId(scope.workspaceId, scope.projectId, shortId, args.locale);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    id: review.article.shortId,
    locale: review.locale,
    state: review.state,
    isStale: review.isStale,
    textKind: review.textKind,
    reviewedBy: review.reviewedBy,
    reviewedAt: review.reviewedAt,
    lastError: review.lastError,
    hasProposal: review.proposal !== null,
    // What a reviewer should look at: the source segments that changed since the text was made.
    changes: review.changes?.filter(change => change.change !== SegmentChanges.same) ?? null,
    ...(isDetailed && { source: review.source, text: review.text, proposal: review.proposal }),
  };
}

export async function listHelpGlossary(deps: HelpToolDeps, args: ListHelpGlossaryArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const { terms } = await deps.helpGlossary.list(scope.workspaceId, scope.projectId);
  const query = args.query?.toLowerCase();
  const { locale } = args;
  const matching = terms
    .map(term => ({
      ...term,
      translations:
        locale === undefined
          ? term.translations
          : Object.fromEntries(Object.entries(term.translations).filter(([key]) => key === locale)),
    }))
    .filter(
      term =>
        (args.rule === undefined || term.rule === args.rule) &&
        (locale === undefined || term.rule === GlossaryRules.keep || Object.keys(term.translations).length > 0) &&
        (query === undefined ||
          [term.term, ...Object.values(term.translations)].join('\n').toLowerCase().includes(query)),
    );
  const page = matching.slice(args.offset, args.offset + args.limit);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    total: matching.length,
    terms: page.map(term => ({
      term: term.term,
      rule: term.rule,
      ...(term.rule === GlossaryRules.fixed && { translations: term.translations }),
      ...(isDetailed && { id: term.id, note: term.note, updatedAt: term.updatedAt }),
    })),
    // Present when there is more: pass it back as `offset`.
    ...(args.offset + page.length < matching.length && { nextOffset: args.offset + page.length }),
  };
}

export function registerHelpTools(server: McpServer, deps: HelpToolDeps): void {
  server.registerTool(
    'mocco_help_glossary_list',
    {
      title: 'List the help center glossary',
      description:
        "A project's help center glossary, which every translation follows: terms kept as written in every language (product names, UI labels) and terms translated one fixed way per language, filtered by text, rule and language, paged. Read-only: mocco_help_glossary_set changes it.",
      inputSchema: glossaryInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listHelpGlossary(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_help_translations_list',
    {
      title: 'List help center translations',
      description:
        "A project's help center translations: per language, how many published articles are machine translated, reviewed, stale (made from an older source), failed or not translated; and the articles a filter lists (by default the ones needing attention), each with its status per language. Read-only.",
      inputSchema: translationsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listHelpTranslations(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_help_translation_get',
    {
      title: 'Read a help article translation',
      description:
        'One published help article in one language, for review: its state, who reviewed it and when, whether a machine draft waits, and the source segments that changed since it was made (before and after). Detailed adds the source, the translation and the draft as Markdown. Read-only: mocco_help_translation_accept accepts the draft, and mocco_help_translation_retranslate translates again.',
      inputSchema: translationInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getHelpTranslation(deps, args, userIdOf(ctx))),
  );

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
        'One published help center article as Markdown, in the asked language where translated (else the source language; `locale` says which), with the languages it is published in and readers\' "Was this helpful?" answers over the last 30 days (yes, no, share of yes; detailed adds the newest comments). Read-only.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getHelpArticle(deps, args, userIdOf(ctx))),
  );
}
