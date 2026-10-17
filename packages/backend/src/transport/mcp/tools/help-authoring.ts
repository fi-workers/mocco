// The help center as its editors see it: the site's settings and tree, every article with
// its draft (published or not), and an article's history. `mocco_help_articles_*` read what
// the public site serves; these read what the console's editor shows, so an agent can find
// the article it is about to change and the state a change would be confirmed against.
//
// Thin adapters (ADR 0025) over `HelpSiteService.get` and `HelpAuthoringService` (`tree`,
// `article`, `history`), the services the console's `help` router reads through. Every call
// first goes through `ProjectScope` (membership, the help center product, the project in that
// workspace) with the caller's own id. The filtering and paging here only narrow what the
// service returned; they decide nothing. Changing tools are in `help-authoring-write.ts`.
import { ArticleStatuses } from '@mocco/common/help';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { HelpNodeNotFoundError } from '@backend/domain/helpcenter/errors';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { HelpAuthoringService } from '@backend/domain/helpcenter/HelpAuthoringService';
import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { McpServer } from '@modelcontextprotocol/server';

export interface HelpAuthoringToolDeps {
  /** The site's settings, or nothing while the project has no help center. */
  helpSites: Pick<HelpSiteService, 'get'>;
  /** The editor's reads: the tree with every article's draft, one article, its history. */
  helpAuthoring: Pick<HelpAuthoringService, 'tree' | 'article' | 'history'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** How much of a text a concise read shows. */
export const EXCERPT_CHARS = 600;

export const helpProjectArg = z
  .uuid()
  .optional()
  .describe('The project the help center belongs to. Omit it when the workspace has exactly one.');

/** An article by the id agents know it by: the 6-character id, or `{id}-{slug}` from its path. */
export const helpArticleRefArg = z
  .string()
  .regex(/^[a-z0-9]{6}(?:-[a-z0-9-]{0,80})?$/u)
  .describe('The article id (6 characters), or the `{id}-{slug}` from its path, as mocco_help_drafts_list returns it.');

const responseFormatArg = (concise: string, detailed: string) =>
  z.enum(['concise', 'detailed']).default('concise').describe(`\`concise\` is ${concise}; \`detailed\` ${detailed}.`);

const siteInput = z.object({ workspaceId: workspaceArg, projectId: helpProjectArg });

const draftsInput = z.object({
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
  status: z
    .enum([ArticleStatuses.draft, ArticleStatuses.published, 'all'])
    .default('all')
    .describe('`draft`: never published or taken off the site. `published`: on the site. `all` (the default).'),
  hasUnpublishedChanges: z
    .boolean()
    .optional()
    .describe('Only articles whose draft differs from what is published (`true`), or that match it (`false`).'),
  collectionId: z.uuid().optional().describe('Only this collection, as mocco_help_site_get lists it.'),
  sectionId: z.uuid().optional().describe('Only this section, as mocco_help_site_get lists it.'),
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Only articles whose draft title contains this text (case-insensitive).'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0).describe("Paging: the previous answer's `nextOffset`, as it was given."),
  responseFormat: responseFormatArg(
    "each article's id, draft title, status and whether its draft differs from what is published",
    'adds its slug, collection and section',
  ),
});

const draftInput = z.object({
  articleId: helpArticleRefArg,
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
  responseFormat: responseFormatArg(
    `the article's status, place, draft and published revision, and the first ${String(EXCERPT_CHARS)} characters of the draft`,
    "the draft's whole Markdown",
  ),
});

const revisionsInput = z.object({
  articleId: helpArticleRefArg,
  revisionId: z
    .uuid()
    .optional()
    .describe('One revision, with its whole Markdown, as this tool listed it. Omit it to list the history.'),
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0).describe("Paging: the previous answer's `nextOffset`, as it was given."),
  responseFormat: responseFormatArg(
    "each revision's id, kind, title and date, and whether it is the draft or the published text",
    `adds the first ${String(EXCERPT_CHARS)} characters of each`,
  ),
});

export type GetHelpSiteArgs = z.infer<typeof siteInput>;
export type ListHelpDraftsArgs = z.infer<typeof draftsInput>;
export type GetHelpDraftArgs = z.infer<typeof draftInput>;
export type ListHelpRevisionsArgs = z.infer<typeof revisionsInput>;

type Tree = Awaited<ReturnType<HelpAuthoringService['tree']>>;

export const resolveHelpProject = async (
  deps: { projects: Pick<ProjectScope, 'resolve'> },
  userId: string,
  asked: Partial<ProjectInScope>,
) => await deps.projects.resolve(userId, asked, Products.helpcenter);

// eslint-disable-next-line sonarjs/null-dereference -- a string parameter, never null
export const excerpt = (text: string) => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text);

/** Every article of the tree with its collection and section, in the site's order. */
export const articlesOf = (tree: Tree) =>
  tree.flatMap(collection =>
    collection.sections.flatMap(section =>
      section.articles.map(article => ({
        article,
        collection: { id: collection.id, title: collection.title },
        section: { id: section.id, title: section.title },
      })),
    ),
  );

/** The article an agent names by its short id (or `{id}-{slug}`), with its place, or not found. */
export function findArticle(tree: Tree, ref: string) {
  // eslint-disable-next-line sonarjs/null-dereference -- a string parameter, never null
  const [shortId = ref] = ref.split('-');
  const found = articlesOf(tree).find(entry => entry.article.shortId === shortId);
  if (found === undefined) {
    throw new HelpNodeNotFoundError('article', shortId);
  }
  return found;
}

/** How many articles a section has, and how many of them are published. */
const countOf = (articles: Tree[number]['sections'][number]['articles']) => ({
  articles: articles.length,
  published: articles.filter(article => article.status === ArticleStatuses.published).length,
});

export async function getHelpSite(deps: HelpAuthoringToolDeps, args: GetHelpSiteArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const site = await deps.helpSites.get(scope.workspaceId, scope.projectId);
  if (site === undefined) {
    return {
      site: null,
      reason: 'This project has no help center yet. mocco_help_site_enable sets one up.',
    };
  }
  const tree = await deps.helpAuthoring.tree(scope.workspaceId, scope.projectId);
  return {
    site: {
      slug: site.slug,
      sourceLocale: site.sourceLocale,
      locales: site.locales,
      allowAiTraining: site.allowAiTraining,
      createdAt: site.createdAt,
    },
    collections: tree.map(collection => ({
      id: collection.id,
      slug: collection.slug,
      title: collection.title,
      description: collection.description,
      sections: collection.sections.map(section => ({
        id: section.id,
        title: section.title,
        ...countOf(section.articles),
      })),
    })),
  };
}

export async function listHelpDrafts(deps: HelpAuthoringToolDeps, args: ListHelpDraftsArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const tree = await deps.helpAuthoring.tree(scope.workspaceId, scope.projectId);
  const query = args.query?.toLowerCase();
  const matching = articlesOf(tree).filter(
    ({ article, collection, section }) =>
      (args.status === 'all' || article.status === args.status) &&
      (args.hasUnpublishedChanges === undefined || article.hasUnpublishedChanges === args.hasUnpublishedChanges) &&
      (args.collectionId === undefined || collection.id === args.collectionId) &&
      (args.sectionId === undefined || section.id === args.sectionId) &&
      (query === undefined || article.title.toLowerCase().includes(query)),
  );
  const page = matching.slice(args.offset, args.offset + args.limit);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    total: matching.length,
    articles: page.map(({ article, collection, section }) => ({
      id: article.shortId,
      title: article.title,
      status: article.status,
      hasUnpublishedChanges: article.hasUnpublishedChanges,
      ...(isDetailed && { slug: article.slug, collection, section }),
    })),
    // Present when there is more: pass it back as `offset`.
    ...(args.offset + page.length < matching.length && { nextOffset: args.offset + page.length }),
  };
}

export async function getHelpDraft(deps: HelpAuthoringToolDeps, args: GetHelpDraftArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const tree = await deps.helpAuthoring.tree(scope.workspaceId, scope.projectId);
  const { article: entry, collection, section } = findArticle(tree, args.articleId);
  const article = await deps.helpAuthoring.article(scope.workspaceId, scope.projectId, entry.id);
  const isDetailed = args.responseFormat === 'detailed';
  const { draft, published } = article;
  const isCut = !isDetailed && draft !== null && draft.body.length > EXCERPT_CHARS;
  return {
    id: article.shortId,
    slug: article.slug,
    status: article.status,
    collection,
    section,
    publishedAt: article.publishedAt,
    hasUnpublishedChanges: draft !== null && draft.id !== published?.id,
    draft:
      draft === null
        ? null
        : {
            revisionId: draft.id,
            kind: draft.kind,
            title: draft.title,
            createdAt: draft.createdAt,
            body: isDetailed ? draft.body : excerpt(draft.body),
            ...(isCut && { isTruncated: true }),
          },
    published: published === null ? null : { revisionId: published.id, title: published.title },
  };
}

export async function listHelpRevisions(deps: HelpAuthoringToolDeps, args: ListHelpRevisionsArgs, userId: string) {
  const scope = await resolveHelpProject(deps, userId, args);
  const tree = await deps.helpAuthoring.tree(scope.workspaceId, scope.projectId);
  const { article: entry } = findArticle(tree, args.articleId);
  const article = await deps.helpAuthoring.article(scope.workspaceId, scope.projectId, entry.id);
  const revisions = await deps.helpAuthoring.history(scope.workspaceId, scope.projectId, entry.id);
  const roleOf = (id: string) => ({
    isDraft: id === article.draft?.id,
    isPublished: id === article.published?.id,
  });
  if (args.revisionId !== undefined) {
    const revision = revisions.find(each => each.id === args.revisionId);
    if (revision === undefined) {
      throw new HelpNodeNotFoundError('revision', args.revisionId);
    }
    return {
      id: article.shortId,
      revision: {
        revisionId: revision.id,
        kind: revision.kind,
        title: revision.title,
        createdAt: revision.createdAt,
        ...roleOf(revision.id),
        body: revision.body,
      },
    };
  }
  const page = revisions.slice(args.offset, args.offset + args.limit);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    id: article.shortId,
    total: revisions.length,
    revisions: page.map(revision => ({
      revisionId: revision.id,
      kind: revision.kind,
      title: revision.title,
      createdAt: revision.createdAt,
      ...roleOf(revision.id),
      ...(isDetailed && { body: excerpt(revision.body) }),
    })),
    // Present when there is more: pass it back as `offset`.
    ...(args.offset + page.length < revisions.length && { nextOffset: args.offset + page.length }),
  };
}

export function registerHelpAuthoringTools(server: McpServer, deps: HelpAuthoringToolDeps): void {
  server.registerTool(
    'mocco_help_site_get',
    {
      title: 'Read the help center setup',
      description:
        "A project's help center as its editors see it: its address (slug), the language it is written in, the languages it is translated into, and its collections and sections with their ids and how many articles each has (published or not). Read-only: mocco_help_site_enable sets one up.",
      inputSchema: siteInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getHelpSite(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_help_drafts_list',
    {
      title: 'List help articles, drafts included',
      description:
        "A project's help center articles as the editor lists them, published or not: each with its draft title, status and whether its draft differs from what is published, filtered by status, collection, section and title, paged. Read-only: mocco_help_articles_search reads only what is published.",
      inputSchema: draftsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listHelpDrafts(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_help_draft_get',
    {
      title: 'Read a help article draft',
      description:
        'One help center article as the editor shows it, published or not: its status, collection and section, its draft (title and Markdown) and its published revision. Read-only: mocco_help_draft_save changes the draft, and mocco_help_article_publish publishes it.',
      inputSchema: draftInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getHelpDraft(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_help_revisions_list',
    {
      title: "List a help article's revisions",
      description:
        "A help center article's history in its source language, newest first: every saved, restored and imported revision, which one is the draft and which is published, paged; or one revision with its whole Markdown. Read-only: mocco_help_draft_restore makes an old one the draft again.",
      inputSchema: revisionsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listHelpRevisions(deps, args, userIdOf(ctx))),
  );
}
