// `mocco_messenger_*` — a project's inbox: which conversations are open, whose they are and
// who wrote them; one conversation's thread, internal notes included, with what is attached;
// and, as changes, replying to the contact and giving the conversation to someone.
//
// Thin adapters (ADR 0025) over `InboxService`, the service the console's `messenger` router
// calls for the same answers and the same changes (`list`, `get`, `write`, `assign`). The
// messenger is project-scoped, so every call first goes through `ProjectScope` with
// `Products.messenger` and the caller's own id; the service then looks a conversation up only
// inside that workspace and project, so another tenant's reads exactly like one that does not
// exist.
//
// A message's attachments are metadata only: id, file name, type and size. The service signs a
// short-lived download link for each, as the console needs; none of them leaves here, so an
// answer the model keeps (or repeats somewhere) carries no working link to anyone's files.
//
// Replying and assigning change what a customer reads and who owns their conversation, so both
// are behind the locks of every changing tool (`openDecision`, `confirmThenApply` in
// `deciding.ts`): their own `messenger:write` scope, stepped up for per tool, the workspace's
// opt-in, and a confirmation that shows the exact reply, or who the conversation goes from and
// to, before anything is written. Text only: attaching a file from an agent, internal notes,
// closing and blocking stay in the console for now.
import { createHash } from 'node:crypto';

import { McpScopes } from '@mocco/common/mcp';
import { AuthorKinds, ConversationStatuses, MessageVisibilities, MessengerLimits } from '@mocco/common/messenger';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { BadRequestError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { contactLabel } from '@backend/domain/messenger/messages';
import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { InboxService } from '@backend/domain/messenger/InboxService';
import type { InboxFilter } from '@backend/domain/messenger/repos/conversation.repo';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface MessengerToolDeps extends DecidingToolDeps {
  messengerInbox: Pick<InboxService, 'list' | 'get' | 'write' | 'assign' | 'assignable'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const MESSENGER_REPLY_TOOL = 'mocco_messenger_reply';
export const MESSENGER_ASSIGN_TOOL = 'mocco_messenger_assign';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = MessengerLimits.pageSize;
const DEFAULT_MESSAGES = 50;
const MAX_MESSAGES = 200;

/** Conversations in one status, or both. */
const StatusFilters = { all: 'all', ...ConversationStatuses } as const;
type StatusFilter = (typeof StatusFilters)[keyof typeof StatusFilters];
const statusFilters = Object.values(StatusFilters) as [StatusFilter, ...StatusFilter[]];

/** Who a conversation is with, in words: the caller, or no one. */
const AssigneeWords = { me: 'me', unassigned: 'unassigned' } as const;

const projectArg = z
  .uuid()
  .optional()
  .describe('The project whose inbox to use. Omit it when the workspace has exactly one.');

const responseFormatArg = (concise: string, detailed: string) =>
  z.enum(['concise', 'detailed']).default('concise').describe(`\`concise\` is ${concise}; \`detailed\` ${detailed}.`);

const conversationArg = z.uuid().describe('The conversation id, as `mocco_messenger_conversations_search` returns it.');

const searchInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  status: z
    .enum(statusFilters)
    .default(StatusFilters.open)
    .describe('`open` (the default), `closed`, or `all` for both.'),
  assignee: z
    .union([z.enum([AssigneeWords.me, AssigneeWords.unassigned]), z.uuid()])
    .optional()
    .describe(
      "Only the conversations of one team member: `me`, a user id (as an answer's `assignee.userId` gives it), or `unassigned` for the ones no one has. Omit it for everyone's.",
    ),
  contact: z
    .string()
    .trim()
    .min(1)
    .max(320)
    .optional()
    .describe("Only one contact's conversations: their contact id, email (any case) or the app's user id, exactly."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  before: z.iso.datetime().optional().describe("Cursor: the previous answer's `nextBefore`, as it was given."),
  responseFormat: responseFormatArg(
    'id, status, the contact, the assignee, a preview of the latest message, when it was and whether you have read it',
    "adds the category, when the conversation started, and the contact's email and the app's user id",
  ),
});

const readInput = z.object({
  conversationId: conversationArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_MESSAGES)
    .default(DEFAULT_MESSAGES)
    .describe('How many of the latest messages to return, oldest first; `earlierMessages` counts the rest.'),
  responseFormat: responseFormatArg(
    "the conversation, who it is with and every message (internal notes marked) with its attachments' names, types and sizes",
    "adds the contact's email, the app's user id, traits and latest device, the device the conversation opened on, and the device each message was sent from",
  ),
});

const replyInput = z.object({
  conversationId: conversationArg,
  body: z
    .string()
    .trim()
    .min(1)
    .max(MessengerLimits.bodyMax)
    .describe('The reply, as the contact will read it in the app. Plain text.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const assignInput = z.object({
  conversationId: conversationArg,
  assignee: z
    .union([z.enum([AssigneeWords.me, AssigneeWords.unassigned]), z.uuid()])
    .describe("Who takes it: `me`, a workspace member's user id, or `unassigned` to give it to no one."),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type SearchConversationsArgs = z.infer<typeof searchInput>;
export type GetConversationArgs = z.infer<typeof readInput>;
export type ReplyArgs = z.infer<typeof replyInput>;
export type AssignArgs = z.infer<typeof assignInput>;

const resolveMessengerProject = async (deps: MessengerToolDeps, userId: string, asked: Partial<ProjectInScope>) =>
  await deps.projects.resolve(userId, asked, Products.messenger);

/** `me` is the caller, `unassigned` no one (null), anything else a user id. */
function assigneeOf(word: string, userId: string): string | null {
  if (word === AssigneeWords.unassigned) {
    return null;
  }
  return word === AssigneeWords.me ? userId : word;
}

/** The search's assignee filter: no one's (`unassigned`), one person's, or everyone's. */
function assigneeFilterOf(
  word: string | undefined,
  userId: string,
): Pick<InboxFilter, 'assigneeUserId' | 'unassigned'> {
  if (word === undefined) {
    return {};
  }
  const assigneeUserId = assigneeOf(word, userId);
  return assigneeUserId === null ? { unassigned: true } : { assigneeUserId };
}

export async function searchConversations(deps: MessengerToolDeps, args: SearchConversationsArgs, userId: string) {
  const scope = await resolveMessengerProject(deps, userId, args);
  const filter: InboxFilter = {
    ...(args.status !== StatusFilters.all && { status: args.status }),
    ...assigneeFilterOf(args.assignee, userId),
    ...(args.contact !== undefined && { contact: args.contact }),
    ...(args.before !== undefined && { before: new Date(args.before) }),
  };
  // One more than asked, to know whether there is a next page.
  const rows = await deps.messengerInbox.list(scope.workspaceId, scope.projectId, userId, {
    ...filter,
    limit: args.limit + 1,
  });
  const page = rows.slice(0, args.limit);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    conversations: page.map(row => ({
      id: row.id,
      status: row.status,
      contact: {
        id: row.contact.id,
        name: contactLabel(row.contact),
        ...(isDetailed && { email: row.contact.email, externalUserId: row.contact.externalUserId }),
      },
      assignee: row.assignee,
      preview: row.preview,
      lastMessageAt: row.lastMessageAt,
      isUnread: row.isUnread,
      ...(isDetailed && { category: row.category, createdAt: row.createdAt }),
    })),
    // Present when there is more: pass it back as `before` for the next page.
    ...(rows.length > page.length && { nextBefore: page.at(-1)?.lastMessageAt.toISOString() }),
  };
}

export async function getConversation(deps: MessengerToolDeps, args: GetConversationArgs, userId: string) {
  const scope = await resolveMessengerProject(deps, userId, args);
  const { conversation, contact, assignee, messages } = await deps.messengerInbox.get(
    scope.workspaceId,
    scope.projectId,
    args.conversationId,
  );
  const isDetailed = args.responseFormat === 'detailed';
  const latest = messages.slice(-args.limit);
  return {
    conversation: {
      id: conversation.id,
      status: conversation.status,
      category: conversation.category,
      assignee,
      createdAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt,
      closedAt: conversation.closedAt,
      ...(isDetailed && { contextAtOpen: conversation.contextAtOpen }),
    },
    contact: {
      id: contact.id,
      name: contactLabel(contact),
      isBlocked: contact.blockedAt !== null,
      ...(isDetailed && {
        email: contact.email,
        externalUserId: contact.externalUserId,
        traits: contact.traits,
        lastContext: contact.lastContext,
        lastSeenAt: contact.lastSeenAt,
      }),
    },
    earlierMessages: messages.length - latest.length,
    messages: latest.map(message => ({
      id: message.id,
      seq: message.seq,
      from: message.authorKind,
      // A team member's name; a contact's message is the contact's.
      authorName: message.authorKind === AuthorKinds.contact ? null : message.authorName,
      isNote: message.visibility === MessageVisibilities.internal,
      body: message.body,
      createdAt: message.createdAt,
      // Metadata only: the signed download link the service made for the console stays here.
      attachments: message.attachments.map(attachment => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
      })),
      ...(isDetailed && { context: message.context }),
    })),
  };
}

/** How the two changing tools name themselves in their refusals. */
const MESSENGER_WRITE = {
  name: McpScopes.messengerWrite,
  allows: 'reply to and assign your messenger conversations',
} as const;

const replyWords: DecisionWords = {
  verb: 'reply in the messenger',
  doing: 'Replying to a conversation',
  scope: MESSENGER_WRITE,
  instead: 'reply from the Inbox in the Mocco console',
};

const assignWords: DecisionWords = {
  verb: 'assign conversations',
  doing: 'Assigning a conversation',
  scope: MESSENGER_WRITE,
  instead: 'assign it from the conversation in the Mocco console',
};

/** The refusals the model reads (not found, which another tenant's conversation reads as too,
 * a workspace or project to pick, someone outside the workspace); anything else is rethrown. */
function messengerRefusal(error: unknown): CallToolResult {
  if (error instanceof NotFoundError || error instanceof BadRequestError || error instanceof ForbiddenError) {
    return refused(error.message);
  }
  throw error;
}

/**
 * The reply's key in the conversation: the same person sending the same text after the same
 * message. A confirmation answered twice (it is valid for five minutes) then sends once —
 * the second finds the first through the conversation's unique client message id.
 */
const replyKeyOf = (userId: string, change: { conversationId: string; afterSeq: number; body: string }) =>
  `mcp:${createHash('sha256')
    .update([userId, change.conversationId, String(change.afterSeq), change.body].join('\0'))
    .digest('hex')
    .slice(0, 32)}`;

/** Send a text reply to the contact as the caller, once they confirm the exact text. */
export async function reply(
  deps: MessengerToolDeps,
  args: ReplyArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, replyWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveMessengerProject(deps, userId, { workspaceId, projectId: args.projectId });
    const { conversation, contact } = await deps.messengerInbox.get(
      scope.workspaceId,
      scope.projectId,
      args.conversationId,
    );
    const who = contactLabel(contact);
    // The latest message when asked: a confirmation is for a reply after exactly that. Once the
    // reply is sent (or the contact writes again), the same confirmation no longer matches.
    const change = {
      tool: MESSENGER_REPLY_TOOL,
      ...scope,
      conversationId: conversation.id,
      afterSeq: conversation.lastMessageSeq,
      body: args.body,
    };
    const question = [
      `Send this reply to ${who}, as you?`,
      `Conversation: ${conversation.id} (${conversation.status})`,
      'They read it in the app, and get a push notification if they turned them on.',
      '',
      args.body,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Send this reply',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const message = await deps.messengerInbox.write(scope.workspaceId, scope.projectId, userId, {
          conversationId: conversation.id,
          body: args.body,
          internal: false,
          clientMessageId: replyKeyOf(userId, change),
        });
        return asJson({
          changed: true,
          conversationId: conversation.id,
          messageId: message.id,
          seq: message.seq,
          createdAt: message.createdAt,
        });
      },
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

/** Give a conversation to a workspace member, or to no one, as the caller, once they confirm. */
export async function assign(
  deps: MessengerToolDeps,
  args: AssignArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, assignWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveMessengerProject(deps, userId, { workspaceId, projectId: args.projectId });
    const {
      conversation,
      contact,
      assignee: current,
    } = await deps.messengerInbox.get(scope.workspaceId, scope.projectId, args.conversationId);
    const to = assigneeOf(args.assignee, userId);
    // Someone outside the workspace is refused before anything is asked.
    const next = to === null ? null : await deps.messengerInbox.assignable(scope.workspaceId, to);
    const from = current?.userId ?? null;
    if (from === to) {
      return asJson({
        changed: false,
        conversationId: conversation.id,
        assignee: current,
        reason: 'It is theirs already.',
      });
    }
    const nameOf = (person: { name: string | null } | null) =>
      person === null ? 'no one' : (person.name ?? 'a former member');
    const toWhom = next === null ? 'no one' : `${next.name} (${next.email})`;
    const question = [
      `Assign this conversation with ${contactLabel(contact)}, as you?`,
      `Conversation: ${conversation.id} (${conversation.status})`,
      `From: ${nameOf(current)}`,
      `To: ${toWhom}`,
    ].join('\n');
    // Bound to who has it now: if someone else reassigns it meanwhile, the person is asked again.
    const change = { tool: MESSENGER_ASSIGN_TOOL, ...scope, conversationId: conversation.id, from, to };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Assign this conversation',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const assigned = await deps.messengerInbox.assign(scope.workspaceId, scope.projectId, userId, {
          conversationId: conversation.id,
          assigneeUserId: to,
        });
        return asJson(assigned);
      },
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

export function registerMessengerTools(server: McpServer, deps: MessengerToolDeps): void {
  server.registerTool(
    'mocco_messenger_conversations_search',
    {
      title: 'Find messenger conversations',
      description:
        "A project's inbox, newest activity first: who each conversation is with, whose it is, a preview of the latest message and whether you have read it. Filter by status (open by default), by assignee (`me`, a user id or `unassigned`) or by contact (id, email or the app's user id). Read-only.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchConversations(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_messenger_conversation_get',
    {
      title: 'Read a messenger conversation',
      description:
        "One conversation's thread, oldest first: every message from the contact and the team, internal notes marked, each with its attachments' names, types and sizes (never a download link); detailed adds the contact's traits and the devices they wrote from. Read-only.",
      inputSchema: readInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getConversation(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    MESSENGER_REPLY_TOOL,
    {
      title: 'Reply in a messenger conversation',
      description:
        'Send a text reply to the contact, as the signed-in person, exactly as the console sends one: they read it in the app and may get a push notification. The person is asked to confirm the exact text in their client first, and it only works where the workspace allows agents to make changes. No attachments or internal notes.',
      inputSchema: replyInput,
      // It writes to a customer; a confirmation answered twice still sends once.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      scopeChallenge: requireScope(
        McpScopes.messengerWrite,
        'Replying needs your permission for this app to reply to and assign your messenger conversations',
      ),
    },
    async (args, ctx) => await reply(deps, args, ctx),
  );

  server.registerTool(
    MESSENGER_ASSIGN_TOOL,
    {
      title: 'Assign a messenger conversation',
      description:
        'Give a conversation to a workspace member (`me` or their user id) or to no one (`unassigned`), as the signed-in person. Round robin only assigns when a conversation starts; this is the hand-off. The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.',
      inputSchema: assignInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireScope(
        McpScopes.messengerWrite,
        'Assigning needs your permission for this app to reply to and assign your messenger conversations',
      ),
    },
    async (args, ctx) => await assign(deps, args, ctx),
  );
}
