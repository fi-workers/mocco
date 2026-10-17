// `mocco_changelog_*` — a feedback board's changelog (#176): which entries it has and in what
// state, one entry whole, and, as changes, writing, editing, publishing, scheduling, unpublishing
// and deleting an entry.
//
// Thin adapters (ADR 0025) over `ChangelogService`, the service the console's `changelog` router
// calls for the same answers and changes (`entries`, `entry`, `create`, `update`, `publish`,
// `schedule`, `unpublish`, `delete`); each tool calls one of its methods, after `ProjectScope` has
// checked the caller's workspace, project and `Products.feedback`. The service looks boards and
// entries up only inside that project, so another tenant's reads exactly like one that does not
// exist.
//
// Every change has the locks of every changing tool (`openDecision`, `confirmThenApply`):
// `feedback:write`, the workspace's opt-in, and a confirmation naming the entry and exactly what
// would change. A change to an existing entry is bound to the entry as shown (its state, when it
// was last changed, its publish time and its posts), so an answer given after anyone else edited,
// published or scheduled it is refused as a different change. A move the entry's state doesn't
// allow is refused before asking with the service's own error. Deleting is here, unlike deleting a
// board: it removes one entry, and the confirmation says when it is public.
import {
  ChangelogEntryStates,
  ChangelogLimits,
  CHANGELOG_SLUG_PATTERN,
  FeedbackLimits,
  changelogEntryStateSchema,
  changelogTagSchema,
} from '@mocco/common/feedback';
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { ChangelogEntryStateError } from '@backend/domain/feedback/errors';
import { confirmThenApply, openDecision, requireScope } from '@backend/transport/mcp/tools/deciding';
import {
  FEEDBACK_WRITE_ALLOWS,
  excerptOf,
  feedbackRefusal,
  projectArg,
  resolveFeedbackProject,
  responseFormatArg,
} from '@backend/transport/mcp/tools/feedback';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { ChangelogEntry, ChangelogService } from '@backend/domain/feedback/ChangelogService';
import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface ChangelogToolDeps extends DecidingToolDeps {
  feedbackChangelog: Pick<
    ChangelogService,
    'get' | 'list' | 'create' | 'update' | 'publish' | 'schedule' | 'unpublish' | 'delete'
  >;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const CHANGELOG_CREATE_TOOL = 'mocco_changelog_entry_create';
export const CHANGELOG_UPDATE_TOOL = 'mocco_changelog_entry_update';
export const CHANGELOG_PUBLISH_TOOL = 'mocco_changelog_entry_publish';
export const CHANGELOG_SCHEDULE_TOOL = 'mocco_changelog_entry_schedule';
export const CHANGELOG_UNPUBLISH_TOOL = 'mocco_changelog_entry_unpublish';
export const CHANGELOG_DELETE_TOOL = 'mocco_changelog_entry_delete';

const DEFAULT_LIMIT = 20;
/** One below the service's page cap, since a search reads one more to know there is a next page. */
const MAX_LIMIT = FeedbackLimits.listMax - 1;

const entryArg = z.uuid().describe('The entry, as `mocco_changelog_entries_search` returns it.');
const titleArg = z.string().trim().min(1).max(ChangelogLimits.titleMax).describe('The entry title.');
const bodyArg = z.string().trim().max(ChangelogLimits.bodyMax).describe('The text, in Markdown.');
const slugArg = z
  .string()
  .regex(CHANGELOG_SLUG_PATTERN)
  .describe('The address on the public changelog: lowercase letters, digits and inner hyphens.');
const tagsArg = z
  .array(changelogTagSchema)
  .max(3)
  .describe('What it announces, any of `new`, `improved` and `fixed`; replaces the list.');
const postIdsArg = z
  .array(z.uuid())
  .max(ChangelogLimits.postsMax)
  .describe("The board's posts it announces, in order (live posts of its board); replaces the list.");

const searchInput = z.object({
  boardId: z.uuid().describe('The board, as `mocco_feedback_boards_list` returns it.'),
  state: changelogEntryStateSchema
    .optional()
    .describe('Only entries in this state: `draft`, `scheduled` or `published`.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0).describe("Paging: the previous answer's `nextOffset`, as it was given."),
  responseFormat: responseFormatArg(
    "each entry's id, address, title, tags, state, when it is scheduled or was published, and how many posts it announces",
    'adds the start of its text, its post ids, and when it was made and last changed',
  ),
});

const readInput = z.object({
  entryId: entryArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    'the entry with the start of its text (500 characters) and its post ids',
    'the whole text, who started it (a user id) and the release run it was drafted from',
  ),
});

const newEntryInput = z.object({
  boardId: z.uuid().describe('The board whose changelog it goes on, as `mocco_feedback_boards_list` returns it.'),
  title: titleArg,
  body: bodyArg.optional(),
  slug: slugArg.optional().describe('Omit it to make one from the title.'),
  tags: tagsArg.optional(),
  postIds: postIdsArg.optional(),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const editInput = z.object({
  entryId: entryArg,
  title: titleArg.optional(),
  body: bodyArg.optional(),
  slug: slugArg.optional(),
  tags: tagsArg.optional(),
  postIds: postIdsArg.optional(),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const entryInput = z.object({ entryId: entryArg, workspaceId: workspaceArg, projectId: projectArg });

const scheduleInput = entryInput.extend({
  publishAt: z.iso
    .datetime({ offset: true })
    .describe('When to publish it, ahead of now, as an ISO 8601 time with its offset (`2026-11-02T09:00:00Z`).'),
});

export type SearchEntriesArgs = z.infer<typeof searchInput>;
export type GetEntryArgs = z.infer<typeof readInput>;
export type CreateEntryArgs = z.infer<typeof newEntryInput>;
export type UpdateEntryArgs = z.infer<typeof editInput>;
export type EntryArgs = z.infer<typeof entryInput>;
export type ScheduleArgs = z.infer<typeof scheduleInput>;

const entrySummary = (entry: ChangelogEntry) => ({
  id: entry.id,
  boardId: entry.boardId,
  slug: entry.slug,
  title: entry.title,
  tags: entry.tags,
  state: entry.state,
  publishAt: entry.publishAt,
  publishedAt: entry.publishedAt,
});

export async function searchEntries(deps: ChangelogToolDeps, args: SearchEntriesArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  // One more than asked, to know whether there is a next page.
  const rows = await deps.feedbackChangelog.list(scope, {
    boardId: args.boardId,
    limit: args.limit + 1,
    offset: args.offset,
    ...(args.state !== undefined && { state: args.state }),
  });
  const page = rows.slice(0, args.limit);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    boardId: args.boardId,
    entries: page.map(entry => ({
      ...entrySummary(entry),
      postCount: entry.postIds.length,
      ...(isDetailed && {
        ...excerptOf({ body: entry.bodyMd }),
        postIds: entry.postIds,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }),
    })),
    ...(rows.length > page.length && { nextOffset: args.offset + page.length }),
  };
}

export async function getEntry(deps: ChangelogToolDeps, args: GetEntryArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const entry = await deps.feedbackChangelog.get(scope, args.entryId);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    entry: {
      ...entrySummary(entry),
      ...(isDetailed
        ? { body: entry.bodyMd, createdByUserId: entry.createdByUserId, sourceRunId: entry.sourceRunId }
        : excerptOf({ body: entry.bodyMd })),
      postIds: entry.postIds,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
  };
}

const writeScope = { name: McpScopes.feedbackWrite, allows: FEEDBACK_WRITE_ALLOWS };
const words = (verb: string, doing: string, instead: string): DecisionWords => ({
  verb,
  doing,
  scope: writeScope,
  instead: `${instead} from the changelog in the Mocco console`,
});
const newEntryWords = words('write changelog entries', 'Writing a changelog entry', 'write it');
const editWords = words('edit changelog entries', 'Editing a changelog entry', 'edit it');
const publishWords = words('publish changelog entries', 'Publishing a changelog entry', 'publish it');
const scheduleWords = words('schedule changelog entries', 'Scheduling a changelog entry', 'schedule it');
const unpublishWords = words('unpublish changelog entries', 'Unpublishing a changelog entry', 'unpublish it');
const removalWords = words('delete changelog entries', 'Deleting a changelog entry', 'delete it');

/** What a confirmation about an existing entry is bound to: anyone changing it asks again. */
const shownState = (entry: ChangelogEntry) => ({
  entryId: entry.id,
  state: entry.state,
  updatedAt: entry.updatedAt.toISOString(),
  publishAt: entry.publishAt?.toISOString() ?? null,
  postIds: entry.postIds,
});

const entryLabel = (entry: Pick<ChangelogEntry, 'title' | 'slug'>) => `"${entry.title}" (${entry.slug})`;

/** Where the entry is now, in the confirmation's words. */
function stateLine(entry: ChangelogEntry): string {
  if (entry.state === ChangelogEntryStates.published) {
    return `It is published (since ${entry.publishedAt?.toISOString() ?? 'now'}): on the public changelog and its RSS feed.`;
  }
  if (entry.state === ChangelogEntryStates.scheduled) {
    return `It is scheduled to publish at ${entry.publishAt?.toISOString() ?? 'its time'}.`;
  }
  return 'It is a draft: only the team sees it.';
}

/** The open checks, the scope and the entry as it is now, for a change to an existing entry. */
async function openOnEntry(deps: ChangelogToolDeps, ctx: ServerContext, args: EntryArgs, decision: DecisionWords) {
  const opened = await openDecision(deps, ctx, args.workspaceId, decision);
  if ('content' in opened) {
    return opened;
  }
  const { userId, workspaceId, confirmations } = opened;
  const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
  const entry = await deps.feedbackChangelog.get(scope, args.entryId);
  return { userId, scope, confirmations, entry };
}

/** Start a draft entry on a board as the caller, once they confirm its words. */
export async function createEntry(
  deps: ChangelogToolDeps,
  args: CreateEntryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, newEntryWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const draft = {
      boardId: args.boardId,
      title: args.title,
      body: args.body ?? '',
      slug: args.slug ?? null,
      tags: args.tags ?? [],
      postIds: args.postIds ?? [],
    };
    const question = [
      `Start the changelog entry "${draft.title}" as a draft, as you?`,
      `Address: ${draft.slug ?? 'made from the title'}`,
      `Tags: ${draft.tags.length === 0 ? 'none' : draft.tags.join(', ')}`,
      `Announces: ${draft.postIds.length === 0 ? 'no posts' : draft.postIds.join(', ')}`,
      'It stays a draft, unseen by end users, until it is published.',
      ...(draft.body === '' ? [] : ['', draft.body]),
    ].join('\n');
    return await confirmThenApply(
      ctx,
      confirmations,
      { tool: CHANGELOG_CREATE_TOOL, ...scope, ...draft },
      {
        label: 'Start this draft',
        ask: async () => await Promise.resolve(question),
        apply: async () => {
          const entry = await deps.feedbackChangelog.create(scope, userId, {
            boardId: draft.boardId,
            title: draft.title,
            body: draft.body,
            ...(draft.slug !== null && { slug: draft.slug }),
            tags: draft.tags,
            postIds: draft.postIds,
          });
          return asJson({ created: true, ...entrySummary(entry), postIds: entry.postIds });
        },
      },
    );
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Edit an entry in any state, once the caller confirms what changes. */
export async function updateEntry(
  deps: ChangelogToolDeps,
  args: UpdateEntryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openOnEntry(deps, ctx, args, editWords);
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, entry } = opened;
    const edit = {
      ...(args.title !== undefined && args.title !== entry.title && { title: args.title }),
      ...(args.body !== undefined && args.body !== entry.bodyMd && { body: args.body }),
      ...(args.slug !== undefined && args.slug !== entry.slug && { slug: args.slug }),
      ...(args.tags !== undefined && args.tags.join(',') !== entry.tags.join(',') && { tags: args.tags }),
      ...(args.postIds !== undefined &&
        args.postIds.join(',') !== entry.postIds.join(',') && { postIds: args.postIds }),
    };
    if (Object.keys(edit).length === 0) {
      return asJson({ changed: false, entryId: entry.id, reason: 'The entry says that already.' });
    }
    const question = [
      `Edit the changelog entry ${entryLabel(entry)}, as you?`,
      stateLine(entry),
      ...(edit.title === undefined ? [] : [`Title: "${entry.title}" → "${edit.title}"`]),
      ...(edit.slug === undefined ? [] : [`Address: ${entry.slug} → ${edit.slug}`]),
      ...(edit.tags === undefined
        ? []
        : [`Tags: ${entry.tags.join(', ') || 'none'} → ${edit.tags.join(', ') || 'none'}`]),
      ...(edit.postIds === undefined ? [] : [`Announces: ${edit.postIds.join(', ') || 'no posts'}`]),
      ...(entry.state === ChangelogEntryStates.published ? ['The public page changes at once.'] : []),
      ...(edit.body === undefined ? [] : ['Text, replacing the old one:', '', edit.body]),
    ].join('\n');
    const change = { tool: CHANGELOG_UPDATE_TOOL, ...scope, ...shownState(entry), edit };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Edit this entry',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await deps.feedbackChangelog.update(scope, entry.id, edit);
        return asJson({ changed: true, ...entrySummary(updated), postIds: updated.postIds });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Publish a draft or scheduled entry now, once the caller confirms. */
export async function publishEntry(
  deps: ChangelogToolDeps,
  args: EntryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openOnEntry(deps, ctx, args, publishWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, entry } = opened;
    if (entry.state === ChangelogEntryStates.published) {
      throw new ChangelogEntryStateError(entry.state, 'publish');
    }
    const question = [
      `Publish the changelog entry ${entryLabel(entry)} now, as you?`,
      stateLine(entry),
      `It announces ${String(entry.postIds.length)} ${entry.postIds.length === 1 ? 'post' : 'posts'}. It goes on the board's public changelog, its RSS feed and the "what's new" count at once, and publishing is recorded in the audit trail.`,
    ].join('\n');
    return await confirmThenApply(
      ctx,
      confirmations,
      { tool: CHANGELOG_PUBLISH_TOOL, ...scope, ...shownState(entry) },
      {
        label: 'Publish this entry',
        ask: async () => await Promise.resolve(question),
        apply: async () => {
          const published = await deps.feedbackChangelog.publish(scope, userId, entry.id);
          return asJson({ changed: true, ...entrySummary(published) });
        },
      },
    );
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Publish a draft (or move a scheduled entry) at a time ahead, once the caller confirms it. */
export async function scheduleEntry(
  deps: ChangelogToolDeps,
  args: ScheduleArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openOnEntry(deps, ctx, args, scheduleWords);
    if ('content' in opened) {
      return opened;
    }
    const { scope, confirmations, entry } = opened;
    if (entry.state === ChangelogEntryStates.published) {
      throw new ChangelogEntryStateError(entry.state, 'schedule');
    }
    const publishAt = new Date(args.publishAt);
    const question = [
      `Schedule the changelog entry ${entryLabel(entry)} to publish at ${publishAt.toISOString()}, as you?`,
      stateLine(entry),
      'Mocco publishes it within a minute of that time; until then only the team sees it.',
    ].join('\n');
    const change = { tool: CHANGELOG_SCHEDULE_TOOL, ...scope, ...shownState(entry), at: publishAt.toISOString() };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Schedule this entry',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        // The service refuses a time that has passed by now.
        const scheduled = await deps.feedbackChangelog.schedule(scope, entry.id, publishAt);
        return asJson({ changed: true, ...entrySummary(scheduled) });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Take a published or scheduled entry back to a draft, once the caller confirms. */
export async function unpublishEntry(
  deps: ChangelogToolDeps,
  args: EntryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openOnEntry(deps, ctx, args, unpublishWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, entry } = opened;
    if (entry.state === ChangelogEntryStates.draft) {
      throw new ChangelogEntryStateError(entry.state, 'unpublish');
    }
    const question = [
      `Take the changelog entry ${entryLabel(entry)} back to a draft, as you?`,
      stateLine(entry),
      entry.state === ChangelogEntryStates.published
        ? 'It leaves the public changelog and its RSS feed at once; unpublishing is recorded in the audit trail.'
        : 'Its schedule is cancelled.',
    ].join('\n');
    return await confirmThenApply(
      ctx,
      confirmations,
      { tool: CHANGELOG_UNPUBLISH_TOOL, ...scope, ...shownState(entry) },
      {
        label: 'Unpublish this entry',
        ask: async () => await Promise.resolve(question),
        apply: async () => {
          const draft = await deps.feedbackChangelog.unpublish(scope, userId, entry.id);
          return asJson({ changed: true, ...entrySummary(draft) });
        },
      },
    );
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Delete an entry in any state, once the caller confirms it, naming whether it is public. */
export async function deleteEntry(
  deps: ChangelogToolDeps,
  args: EntryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openOnEntry(deps, ctx, args, removalWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, entry } = opened;
    const question = [
      `Delete the changelog entry ${entryLabel(entry)}, as you?`,
      stateLine(entry),
      entry.state === ChangelogEntryStates.published
        ? 'Its public page and RSS item go away, and links to it stop working.'
        : 'No one outside the team has seen it.',
      'It cannot be undone; the posts it announces stay as they are. Deleting is recorded in the audit trail.',
    ].join('\n');
    return await confirmThenApply(
      ctx,
      confirmations,
      { tool: CHANGELOG_DELETE_TOOL, ...scope, ...shownState(entry) },
      {
        label: 'Delete this entry',
        ask: async () => await Promise.resolve(question),
        apply: async () => {
          await deps.feedbackChangelog.delete(scope, userId, entry.id);
          return asJson({ deleted: true, entryId: entry.id });
        },
      },
    );
  } catch (error) {
    return feedbackRefusal(error);
  }
}

const challenge = (doing: string) =>
  requireScope(McpScopes.feedbackWrite, `${doing} needs your permission for this app to change your changelog`);
const changing = { readOnlyHint: false, openWorldHint: false } as const;
const asked =
  'The person confirms it in their client first, and it only works where the workspace allows agents to make changes.';

export function registerChangelogTools(server: McpServer, deps: ChangelogToolDeps): void {
  server.registerTool(
    'mocco_changelog_entries_search',
    {
      title: "Find a board's changelog entries",
      description:
        "A feedback board's changelog entries, newest published, scheduled or edited first, optionally in one state (`draft`, `scheduled`, `published`). Page with `limit` and `nextOffset`. Read-only.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchEntries(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_changelog_entry_get',
    {
      title: 'Read a changelog entry',
      description:
        'One changelog entry: its state, address, tags, the posts it announces and its Markdown text (cut short unless detailed). Read-only.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getEntry(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    CHANGELOG_CREATE_TOOL,
    {
      title: 'Start a changelog entry',
      description: `Start a draft changelog entry on a feedback board as the signed-in person: a title, Markdown text, an address, tags and the posts it announces. It stays a draft until published. ${asked}`,
      inputSchema: newEntryInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: false },
      scopeChallenge: challenge('Writing a changelog entry'),
    },
    async (args, ctx) => await createEntry(deps, args, ctx),
  );

  server.registerTool(
    CHANGELOG_UPDATE_TOOL,
    {
      title: 'Edit a changelog entry',
      description: `Edit a changelog entry in any state as the signed-in person; only the fields given change, and \`tags\` and \`postIds\` replace the lists. A published entry's public page changes at once. ${asked}`,
      inputSchema: editInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Editing a changelog entry'),
    },
    async (args, ctx) => await updateEntry(deps, args, ctx),
  );

  server.registerTool(
    CHANGELOG_PUBLISH_TOOL,
    {
      title: 'Publish a changelog entry',
      description: `Publish a draft or scheduled changelog entry now, as the signed-in person: it goes on the board's public changelog and RSS feed. Audited. ${asked}`,
      inputSchema: entryInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Publishing a changelog entry'),
    },
    async (args, ctx) => await publishEntry(deps, args, ctx),
  );

  server.registerTool(
    CHANGELOG_SCHEDULE_TOOL,
    {
      title: 'Schedule a changelog entry',
      description: `Schedule a draft changelog entry (or move a scheduled one) to publish at a time ahead, as the signed-in person; Mocco publishes it within a minute of that time. ${asked}`,
      inputSchema: scheduleInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Scheduling a changelog entry'),
    },
    async (args, ctx) => await scheduleEntry(deps, args, ctx),
  );

  server.registerTool(
    CHANGELOG_UNPUBLISH_TOOL,
    {
      title: 'Unpublish a changelog entry',
      description: `Take a published or scheduled changelog entry back to a draft, as the signed-in person: it leaves the public changelog, or its schedule is cancelled. ${asked}`,
      inputSchema: entryInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Unpublishing a changelog entry'),
    },
    async (args, ctx) => await unpublishEntry(deps, args, ctx),
  );

  server.registerTool(
    CHANGELOG_DELETE_TOOL,
    {
      title: 'Delete a changelog entry',
      description: `Delete a changelog entry in any state, as the signed-in person; a published one leaves the public changelog. It cannot be undone, and the posts it announces stay as they are. Audited. ${asked}`,
      inputSchema: entryInput,
      annotations: { ...changing, destructiveHint: true, idempotentHint: true },
      scopeChallenge: challenge('Deleting a changelog entry'),
    },
    async (args, ctx) => await deleteEntry(deps, args, ctx),
  );
}
