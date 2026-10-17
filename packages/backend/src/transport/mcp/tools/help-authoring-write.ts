// The help center's writing tools (ADR 0025's coverage of the console's editor): set up a help
// center, add a collection or a section, create an article, save and restore its draft,
// publish, unpublish and delete it.
//
// Thin adapters over `HelpSiteService.enable` and `HelpAuthoringService`, the services the
// console's `help` router calls for the same changes. Each tool calls one of them after
// `ProjectScope` has checked the caller's workspace, project and `Products.helpcenter`, and
// acts as the caller: drafts are the caller's revisions, and publishing, unpublishing and
// deleting are audited by the service as the caller.
//
// They have the locks of every changing tool (`openDecision`, `confirmThenApply`): `help:write`,
// the workspace's opt-in, and a confirmation naming exactly what would change. Each confirmation
// is bound to the state it showed, so an answer given after that state moved is refused as a
// different change: an article change to its draft revision and that draft's text (an editing
// session rewrites a revision in place, so the id alone is not enough), its published revision
// and its status; a new section or article to the ids already in its collection or section, so
// a confirmation answered twice creates one. A collection is bound to its slug, which the
// service keeps unique, and a site to the project having none.
//
// Not here, on purpose: the procedures the console does not call (changing a site's address or
// languages, deleting a collection or a section, which takes every article in it along,
// unaudited), the AI training crawler switch (a licensing decision about the site's content,
// kept to a person), images (bytes an MCP call does not carry) and importing a bundle (an
// export converted and uploaded in the console). The help center reference lists them.
import { ArticleStatuses, helpLocaleSchema, helpSiteInputSchema, helpSlugSchema, HelpLimits } from '@mocco/common/help';
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { contentHashOf } from '@backend/domain/helpcenter/content';
import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import {
  excerpt,
  findArticle,
  helpArticleRefArg,
  helpProjectArg,
  resolveHelpProject,
} from '@backend/transport/mcp/tools/help-authoring';
import { helpRefusal, writeScope } from '@backend/transport/mcp/tools/help-write';
import { asJson, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { HelpAuthoringService } from '@backend/domain/helpcenter/HelpAuthoringService';
import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface HelpAuthoringWriteToolDeps extends DecidingToolDeps {
  /** Whether the project has a help center, and the console's set-up. */
  helpSites: Pick<HelpSiteService, 'get' | 'enable'>;
  /** The editor's reads (what a change is bound to) and its changes. */
  helpAuthoring: Pick<
    HelpAuthoringService,
    | 'tree'
    | 'article'
    | 'history'
    | 'createCollection'
    | 'createSection'
    | 'createArticle'
    | 'saveDraft'
    | 'publish'
    | 'unpublish'
    | 'deleteArticle'
    | 'restore'
  >;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const HelpAuthoringTools = {
  siteEnable: 'mocco_help_site_enable',
  collectionCreate: 'mocco_help_collection_create',
  sectionCreate: 'mocco_help_section_create',
  articleCreate: 'mocco_help_article_create',
  draftSave: 'mocco_help_draft_save',
  draftRestore: 'mocco_help_draft_restore',
  articlePublish: 'mocco_help_article_publish',
  articleUnpublish: 'mocco_help_article_unpublish',
  articleDelete: 'mocco_help_article_delete',
} as const;

const titleArg = z.string().trim().min(1).max(HelpLimits.titleMax);
const bodyArg = z
  .string()
  .max(HelpLimits.bodyMax)
  .describe('The whole article as Markdown. It replaces the draft; the history keeps the old one.');

const siteEnableInput = z.object({
  slug: helpSlugSchema.describe('The public address: lowercase letters, digits and hyphens (`acme-help`).'),
  sourceLocale: helpLocaleSchema.describe('The language articles are written in (`en`, `ko`, …).'),
  locales: z
    .array(helpLocaleSchema)
    .default([])
    .describe('The languages articles are translated into by machine, not including the source language.'),
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
});

const collectionCreateInput = z.object({
  title: titleArg.describe('The collection title, as readers see it.'),
  slug: helpSlugSchema.describe("The collection's address in the site: lowercase letters, digits and hyphens."),
  description: z.string().trim().max(HelpLimits.descriptionMax).optional().describe('A line under the title.'),
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
});

const sectionCreateInput = z.object({
  collectionId: z.uuid().describe('The collection to add it to, as mocco_help_site_get lists it.'),
  title: titleArg.describe('The section title, as readers see it.'),
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
});

const articleCreateInput = z.object({
  sectionId: z.uuid().describe('The section to add it to, as mocco_help_site_get lists it.'),
  title: titleArg.describe('The article title.'),
  slug: helpSlugSchema
    .optional()
    .describe("The article's address after its id (`{id}-{slug}`). Omit it to make one from the title."),
  body: bodyArg.optional().describe('The article as Markdown. Omit it to start with an empty draft.'),
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
});

const draftSaveInput = z.object({
  articleId: helpArticleRefArg,
  title: titleArg.describe('The article title.'),
  body: bodyArg,
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
});

const draftRestoreInput = z.object({
  articleId: helpArticleRefArg,
  revisionId: z.uuid().describe('The revision to make the draft again, as mocco_help_revisions_list lists it.'),
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
});

const articleInput = z.object({
  articleId: helpArticleRefArg,
  workspaceId: workspaceArg,
  projectId: helpProjectArg,
});

export type EnableHelpSiteArgs = z.infer<typeof siteEnableInput>;
export type CreateHelpCollectionArgs = z.infer<typeof collectionCreateInput>;
export type CreateHelpSectionArgs = z.infer<typeof sectionCreateInput>;
export type CreateHelpArticleArgs = z.infer<typeof articleCreateInput>;
export type SaveHelpDraftArgs = z.infer<typeof draftSaveInput>;
export type RestoreHelpDraftArgs = z.infer<typeof draftRestoreInput>;
export type HelpArticleArgs = z.infer<typeof articleInput>;

const words = (verb: string, doing: string, instead: string): DecisionWords => ({
  verb,
  doing,
  scope: writeScope(),
  instead,
});

const siteWords = words('set up a help center', 'Setting up a help center', 'set it up in the Mocco console');
const treeWords = words(
  'change the help center',
  'Changing the help center',
  "change it from the help center's editor in the Mocco console",
);
const draftWords = words(
  'write help articles',
  'Writing a help article',
  "write it in the help center's editor in the Mocco console",
);
const publishWords = words(
  'publish help articles',
  'Publishing a help article',
  "publish it from the help center's editor in the Mocco console",
);
const removalWords = words(
  'delete help articles',
  'Deleting a help article',
  "delete it from the help center's editor in the Mocco console",
);

type Opened = Exclude<Awaited<ReturnType<typeof openDecision>>, CallToolResult>;
type Article = Awaited<ReturnType<HelpAuthoringService['article']>>;

/**
 * The checks every change makes before it asks, then the project it is in: `run` gets who
 * decides, where, and the codec to confirm with. Domain refusals become answers the model
 * can act on.
 */
async function changing(
  deps: HelpAuthoringWriteToolDeps,
  ctx: ServerContext,
  args: { workspaceId?: string; projectId?: string },
  decision: DecisionWords,
  run: (opened: Opened, scope: ProjectInScope) => Promise<CallToolResult | InputRequiredResult>,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, decision);
    if ('content' in opened) {
      return opened;
    }
    const scope = await resolveHelpProject(deps, opened.userId, {
      workspaceId: opened.workspaceId,
      projectId: args.projectId,
    });
    return await run(opened, scope);
  } catch (error) {
    return helpRefusal(error);
  }
}

/** An article by the id agents know it by, as the editor reads it now. */
async function articleOf(deps: HelpAuthoringWriteToolDeps, scope: ProjectInScope, ref: string) {
  const tree = await deps.helpAuthoring.tree(scope.workspaceId, scope.projectId);
  const found = findArticle(tree, ref);
  const article = await deps.helpAuthoring.article(scope.workspaceId, scope.projectId, found.article.id);
  return { ...found, article };
}

/** What an article change is bound to: its status, its published revision and its draft, text included. */
const stateOf = (article: Article) => ({
  articleId: article.id,
  status: article.status,
  publishedRevisionId: article.published?.id ?? null,
  draftRevisionId: article.draft?.id ?? null,
  draftHash: article.draft === null ? null : contentHashOf(article.draft.title, article.draft.body),
});

const labelOf = (article: Article) => `${article.shortId} "${article.draft?.title ?? article.published?.title ?? ''}"`;

const isPublished = (article: Article) => article.status === ArticleStatuses.published;

const unchanged = (reason: string, extra: Record<string, unknown> = {}) => asJson({ changed: false, ...extra, reason });

/** What a saved, restored or published article is now. */
const summaryOf = (article: Article) => ({
  id: article.shortId,
  slug: article.slug,
  status: article.status,
  draftRevisionId: article.draft?.id ?? null,
  publishedRevisionId: article.published?.id ?? null,
  publishedAt: article.publishedAt,
});

/** Set up the project's help center, once the caller confirms its address and languages. */
export async function enableHelpSite(
  deps: HelpAuthoringWriteToolDeps,
  args: EnableHelpSiteArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, siteWords, async ({ userId, confirmations }, scope) => {
    const existing = await deps.helpSites.get(scope.workspaceId, scope.projectId);
    if (existing !== undefined) {
      return unchanged('This project has a help center already.', { slug: existing.slug });
    }
    const parsed = helpSiteInputSchema.safeParse({
      slug: args.slug,
      sourceLocale: args.sourceLocale,
      locales: args.locales,
    });
    if (!parsed.success) {
      return refused(parsed.error.issues.map(issue => issue.message).join('; '));
    }
    const site = parsed.data;
    const change = { tool: HelpAuthoringTools.siteEnable, ...scope, site };
    const question = [
      `Set up a help center for this project at the address "${site.slug}", as you?`,
      `Written in: ${site.sourceLocale}`,
      `Translated by machine into: ${site.locales.length === 0 ? 'no other language' : site.locales.join(', ')}`,
      'Articles are public once they are published.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Set up the help center',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const enabled = await deps.helpSites.enable(scope.workspaceId, scope.projectId, userId, site);
        return asJson({
          changed: true,
          slug: enabled.slug,
          sourceLocale: enabled.sourceLocale,
          locales: enabled.locales,
        });
      },
    });
  });
}

/** Add a collection, once the caller confirms its title and address. */
export async function createHelpCollection(
  deps: HelpAuthoringWriteToolDeps,
  args: CreateHelpCollectionArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, treeWords, async ({ confirmations }, scope) => {
    const tree = await deps.helpAuthoring.tree(scope.workspaceId, scope.projectId);
    const taken = tree.find(collection => collection.slug === args.slug);
    if (taken !== undefined) {
      return unchanged(`The help center has a collection at "${args.slug}" already.`, {
        collection: { id: taken.id, title: taken.title },
      });
    }
    const input = {
      title: args.title,
      slug: args.slug,
      ...(args.description !== undefined && args.description !== '' && { description: args.description }),
    };
    const change = { tool: HelpAuthoringTools.collectionCreate, ...scope, collection: input };
    const question = [
      `Add the collection "${input.title}" at "${input.slug}" to the help center, as you?`,
      ...(input.description === undefined ? [] : [`Description: ${input.description}`]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add this collection',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const created = await deps.helpAuthoring.createCollection(scope.workspaceId, scope.projectId, input);
        return asJson({ changed: true, collection: { id: created.id, slug: created.slug, title: created.title } });
      },
    });
  });
}

/** Add a section to a collection, once the caller confirms it. */
export async function createHelpSection(
  deps: HelpAuthoringWriteToolDeps,
  args: CreateHelpSectionArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, treeWords, async ({ confirmations }, scope) => {
    const tree = await deps.helpAuthoring.tree(scope.workspaceId, scope.projectId);
    const collection = tree.find(each => each.id === args.collectionId);
    if (collection === undefined) {
      return refused(`No collection ${args.collectionId} in this help center. mocco_help_site_get lists them.`);
    }
    // Bound to the sections the collection has now: answered twice, the second finds one more.
    const change = {
      tool: HelpAuthoringTools.sectionCreate,
      ...scope,
      collectionId: collection.id,
      title: args.title,
      sectionIds: collection.sections.map(section => section.id),
    };
    const question = `Add the section "${args.title}" to the collection "${collection.title}", as you?`;
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add this section',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const created = await deps.helpAuthoring.createSection(scope.workspaceId, scope.projectId, {
          collectionId: collection.id,
          title: args.title,
        });
        return asJson({
          changed: true,
          section: { id: created.id, title: created.title, collectionId: collection.id },
        });
      },
    });
  });
}

/** Create a draft article in a section, with its text when given, once the caller confirms it. */
export async function createHelpArticle(
  deps: HelpAuthoringWriteToolDeps,
  args: CreateHelpArticleArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, draftWords, async ({ userId, confirmations }, scope) => {
    const tree = await deps.helpAuthoring.tree(scope.workspaceId, scope.projectId);
    const place = tree.flatMap(collection =>
      collection.sections.filter(section => section.id === args.sectionId).map(section => ({ collection, section })),
    )[0];
    if (place === undefined) {
      return refused(`No section ${args.sectionId} in this help center. mocco_help_site_get lists them.`);
    }
    const body = args.body ?? '';
    // Bound to the articles the section has now: answered twice, the second finds one more.
    const change = {
      tool: HelpAuthoringTools.articleCreate,
      ...scope,
      sectionId: place.section.id,
      title: args.title,
      slug: args.slug ?? null,
      bodyHash: contentHashOf(args.title, body),
      articleIds: place.section.articles.map(article => article.id),
    };
    const question = [
      `Create the article "${args.title}" in ${place.collection.title} › ${place.section.title} as a draft, as you?`,
      'Nothing is public until it is published.',
      ...(body === '' ? ['It starts empty.'] : ['', excerpt(body)]),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Create this article',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const created = await deps.helpAuthoring.createArticle(scope.workspaceId, scope.projectId, userId, {
          sectionId: place.section.id,
          title: args.title,
          ...(args.slug !== undefined && { slug: args.slug }),
        });
        const article =
          body === ''
            ? created
            : await deps.helpAuthoring.saveDraft(scope.workspaceId, scope.projectId, userId, {
                articleId: created.id,
                title: args.title,
                body,
              });
        return asJson({ changed: true, created: true, ...summaryOf(article) });
      },
    });
  });
}

/** Replace an article's draft with a new title and Markdown, once the caller confirms it. */
export async function saveHelpDraft(
  deps: HelpAuthoringWriteToolDeps,
  args: SaveHelpDraftArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, draftWords, async ({ userId, confirmations }, scope) => {
    const { article } = await articleOf(deps, scope, args.articleId);
    const before = stateOf(article);
    const afterHash = contentHashOf(args.title, args.body);
    if (before.draftHash === afterHash) {
      return unchanged('The draft has this text already.', { id: article.shortId });
    }
    const change = { tool: HelpAuthoringTools.draftSave, ...scope, before, afterHash };
    const now =
      article.draft === null ? 'no text' : `"${article.draft.title}", ${String(article.draft.body.length)} characters`;
    const question = [
      `Save a new draft of article ${labelOf(article)}, as you?`,
      `Now: ${now}`,
      `After: "${args.title}", ${String(args.body.length)} characters`,
      isPublished(article)
        ? 'The site keeps the published text until the article is published again.'
        : 'It is not published, so the site does not show it.',
      '',
      excerpt(args.body),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Save this draft',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const saved = await deps.helpAuthoring.saveDraft(scope.workspaceId, scope.projectId, userId, {
          articleId: article.id,
          title: args.title,
          body: args.body,
        });
        return asJson({ changed: true, ...summaryOf(saved) });
      },
    });
  });
}

/** Make an earlier revision the article's draft again, once the caller confirms it. */
export async function restoreHelpDraft(
  deps: HelpAuthoringWriteToolDeps,
  args: RestoreHelpDraftArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, draftWords, async ({ userId, confirmations }, scope) => {
    const { article } = await articleOf(deps, scope, args.articleId);
    // The history the console offers to restore from: the source language's revisions.
    const history = await deps.helpAuthoring.history(scope.workspaceId, scope.projectId, article.id);
    const revision = history.find(each => each.id === args.revisionId);
    if (revision === undefined) {
      return refused(
        `Revision ${args.revisionId} is not in the history of article ${article.shortId}. mocco_help_revisions_list lists it.`,
      );
    }
    const before = stateOf(article);
    if (before.draftHash === contentHashOf(revision.title, revision.body)) {
      return unchanged('The draft has this text already.', { id: article.shortId });
    }
    const change = { tool: HelpAuthoringTools.draftRestore, ...scope, before, revisionId: revision.id };
    const question = [
      `Make the ${revision.createdAt.toISOString()} revision of article ${labelOf(article)} its draft again, as you?`,
      'It is saved as a new revision; the history keeps every other one.',
      isPublished(article)
        ? 'The site keeps the published text until the article is published again.'
        : 'It is not published, so the site does not show it.',
      '',
      revision.title,
      '',
      excerpt(revision.body),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Restore this revision',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const restored = await deps.helpAuthoring.restore(
          scope.workspaceId,
          scope.projectId,
          userId,
          article.id,
          revision.id,
        );
        return asJson({ changed: true, restoredFrom: revision.id, ...summaryOf(restored) });
      },
    });
  });
}

/** Publish an article's draft, once the caller confirms exactly that draft. */
export async function publishHelpArticle(
  deps: HelpAuthoringWriteToolDeps,
  args: HelpArticleArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, publishWords, async ({ userId, confirmations }, scope) => {
    const { article } = await articleOf(deps, scope, args.articleId);
    const { draft } = article;
    if (draft === null) {
      return refused(`Article ${article.shortId} has no text to publish. mocco_help_draft_save writes it.`);
    }
    if (isPublished(article) && draft.id === article.published?.id) {
      return unchanged('It is published already, as its draft is.', { id: article.shortId });
    }
    const change = { tool: HelpAuthoringTools.articlePublish, ...scope, before: stateOf(article) };
    const question = [
      `Publish article ${labelOf(article)} on the help center, as you?`,
      isPublished(article)
        ? 'Its draft replaces the text readers see now; the history keeps that text.'
        : 'It becomes public.',
      "The site's other languages are then translated from it.",
      '',
      draft.title,
      '',
      excerpt(draft.body),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Publish this article',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const published = await deps.helpAuthoring.publish(scope.workspaceId, scope.projectId, userId, article.id);
        return asJson({ changed: true, ...summaryOf(published) });
      },
    });
  });
}

/** Take an article off the public site, once the caller confirms it. */
export async function unpublishHelpArticle(
  deps: HelpAuthoringWriteToolDeps,
  args: HelpArticleArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, publishWords, async ({ userId, confirmations }, scope) => {
    const { article } = await articleOf(deps, scope, args.articleId);
    if (!isPublished(article)) {
      return unchanged('It is not published.', { id: article.shortId, status: article.status });
    }
    const change = { tool: HelpAuthoringTools.articleUnpublish, ...scope, before: stateOf(article) };
    const question = [
      `Take article ${labelOf(article)} off the public help center, as you?`,
      'Its text, history and translations stay, and publishing it again brings it back. Until then, links to it find nothing.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Unpublish this article',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const unpublished = await deps.helpAuthoring.unpublish(scope.workspaceId, scope.projectId, userId, article.id);
        return asJson({ changed: true, ...summaryOf(unpublished) });
      },
    });
  });
}

/** Delete an article and its history, once the caller confirms exactly that article as it is. */
export async function deleteHelpArticle(
  deps: HelpAuthoringWriteToolDeps,
  args: HelpArticleArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  return await changing(deps, ctx, args, removalWords, async ({ userId, confirmations }, scope) => {
    const { article, collection, section } = await articleOf(deps, scope, args.articleId);
    const change = { tool: HelpAuthoringTools.articleDelete, ...scope, before: stateOf(article) };
    const question = [
      `Delete article ${labelOf(article)} from ${collection.title} › ${section.title} for good, as you?`,
      isPublished(article) ? 'It is published: readers lose it at once.' : 'It is not published.',
      'Its text, every revision and its translations are deleted and cannot be brought back. mocco_help_article_unpublish only takes it off the site.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Delete this article',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await deps.helpAuthoring.deleteArticle(scope.workspaceId, scope.projectId, userId, article.id);
        return asJson({ changed: true, deleted: true, id: article.shortId });
      },
    });
  });
}

const challenge = (doing: string) =>
  requireScope(McpScopes.helpWrite, `${doing} needs your permission for this app to change your help center`);
const changes = { readOnlyHint: false, openWorldHint: false } as const;
const LOCKS = 'The person confirms first, and it only works where the workspace allows agents to make changes.';

export function registerHelpAuthoringWriteTools(server: McpServer, deps: HelpAuthoringWriteToolDeps): void {
  server.registerTool(
    HelpAuthoringTools.siteEnable,
    {
      title: 'Set up a help center',
      description: `Set up a project's help center, as the signed-in person: its public address, the language articles are written in and the languages they are translated into by machine. A project has one; this changes nothing where it exists. ${LOCKS}`,
      inputSchema: siteEnableInput,
      annotations: { ...changes, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Setting up a help center'),
    },
    async (args, ctx) => await enableHelpSite(deps, args, ctx),
  );

  server.registerTool(
    HelpAuthoringTools.collectionCreate,
    {
      title: 'Add a help center collection',
      description: `Add a collection (the top level of a help center, holding sections) at the end of the site, as the signed-in person. ${LOCKS}`,
      inputSchema: collectionCreateInput,
      annotations: { ...changes, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Adding a collection'),
    },
    async (args, ctx) => await createHelpCollection(deps, args, ctx),
  );

  server.registerTool(
    HelpAuthoringTools.sectionCreate,
    {
      title: 'Add a help center section',
      description: `Add a section (a group of articles) at the end of a collection, as the signed-in person. ${LOCKS}`,
      inputSchema: sectionCreateInput,
      annotations: { ...changes, destructiveHint: false, idempotentHint: false },
      scopeChallenge: challenge('Adding a section'),
    },
    async (args, ctx) => await createHelpSection(deps, args, ctx),
  );

  server.registerTool(
    HelpAuthoringTools.articleCreate,
    {
      title: 'Create a help article',
      description: `Create an article at the end of a section as an unpublished draft, with its Markdown when given, as the signed-in person. mocco_help_article_publish makes it public. ${LOCKS}`,
      inputSchema: articleCreateInput,
      annotations: { ...changes, destructiveHint: false, idempotentHint: false },
      scopeChallenge: challenge('Creating an article'),
    },
    async (args, ctx) => await createHelpArticle(deps, args, ctx),
  );

  server.registerTool(
    HelpAuthoringTools.draftSave,
    {
      title: 'Save a help article draft',
      description: `Replace a help article's draft with a new title and Markdown, as the signed-in person; the history keeps the old one. The site keeps the published text until the article is published. Tied to the draft as mocco_help_draft_get read it: an edit made since asks again. ${LOCKS}`,
      inputSchema: draftSaveInput,
      annotations: { ...changes, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Saving a draft'),
    },
    async (args, ctx) => await saveHelpDraft(deps, args, ctx),
  );

  server.registerTool(
    HelpAuthoringTools.draftRestore,
    {
      title: 'Restore a help article revision',
      description: `Make an earlier revision (from mocco_help_revisions_list) a help article's draft again, as a new revision, as the signed-in person. The site keeps the published text until the article is published. ${LOCKS}`,
      inputSchema: draftRestoreInput,
      annotations: { ...changes, destructiveHint: false, idempotentHint: false },
      scopeChallenge: challenge('Restoring a revision'),
    },
    async (args, ctx) => await restoreHelpDraft(deps, args, ctx),
  );

  server.registerTool(
    HelpAuthoringTools.articlePublish,
    {
      title: 'Publish a help article',
      description: `Publish a help article's draft on the public site, as the signed-in person, replacing the text readers see; the site's other languages are then translated from it. Tied to the draft the person saw: an edit made since asks again. ${LOCKS}`,
      inputSchema: articleInput,
      annotations: { ...changes, destructiveHint: true, idempotentHint: true },
      scopeChallenge: challenge('Publishing an article'),
    },
    async (args, ctx) => await publishHelpArticle(deps, args, ctx),
  );

  server.registerTool(
    HelpAuthoringTools.articleUnpublish,
    {
      title: 'Unpublish a help article',
      description: `Take a help article off the public site, as the signed-in person. Its text, history and translations stay, and publishing it again brings it back. ${LOCKS}`,
      inputSchema: articleInput,
      annotations: { ...changes, destructiveHint: true, idempotentHint: true },
      scopeChallenge: challenge('Unpublishing an article'),
    },
    async (args, ctx) => await unpublishHelpArticle(deps, args, ctx),
  );

  server.registerTool(
    HelpAuthoringTools.articleDelete,
    {
      title: 'Delete a help article',
      description: `Delete a help article with its history and translations, for good, as the signed-in person. Tied to the article as the person saw it: an edit, publish or unpublish made since asks again. mocco_help_article_unpublish only takes it off the site. ${LOCKS}`,
      inputSchema: articleInput,
      annotations: { ...changes, destructiveHint: true, idempotentHint: true },
      scopeChallenge: challenge('Deleting an article'),
    },
    async (args, ctx) => await deleteHelpArticle(deps, args, ctx),
  );
}
