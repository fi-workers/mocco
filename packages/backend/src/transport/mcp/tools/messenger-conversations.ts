// `mocco_messenger_*` changes to one conversation or contact, beside the reply and the
// assignment in `messenger.ts`: closing a conversation or opening it again, leaving an
// internal note only the team sees, and blocking a contact (or letting them write again).
//
// Thin adapters (ADR 0025) over `InboxService`, the service the console's `messenger` router
// calls for the same changes (`setStatus`, `write` with `internal: true`, `setContactBlocked`).
// Each goes through `ProjectScope` with `Products.messenger` and the caller's own id, then the
// locks every changing tool has (`openDecision`, `confirmThenApply`): the `messenger:write`
// scope, the workspace's opt-in, and a confirmation. Each confirmation is bound to the state
// it showed — the status, the conversation's latest message, whether the contact was blocked —
// so a change made by anyone in between makes the old answer a different change, refused.
// A change to what is already so answers without asking.
import { ConversationStatuses, MessengerLimits } from '@mocco/common/messenger';
import { z } from 'zod';

import { contactLabel } from '@backend/domain/messenger/messages';
import { confirmThenApply, openDecision } from '@backend/transport/mcp/tools/deciding';
import {
  conversationArg,
  MESSENGER_WRITE,
  messageKeyOf,
  messengerRefusal,
  projectArg,
  requireMessengerWrite,
  resolveMessengerProject,
} from '@backend/transport/mcp/tools/messenger';
import { asJson, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { InboxService } from '@backend/domain/messenger/InboxService';
import type { DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { MessengerToolDeps } from '@backend/transport/mcp/tools/messenger';
import type { ConversationStatus } from '@mocco/common/messenger';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface MessengerConversationToolDeps extends Omit<MessengerToolDeps, 'messengerInbox'> {
  messengerInbox: Pick<InboxService, 'get' | 'write' | 'setStatus' | 'contact' | 'setContactBlocked'>;
}

export const MESSENGER_SET_STATUS_TOOL = 'mocco_messenger_conversation_set_status';
export const MESSENGER_NOTE_TOOL = 'mocco_messenger_note_create';
export const MESSENGER_BLOCK_TOOL = 'mocco_messenger_contact_set_blocked';

const statuses = Object.values(ConversationStatuses) as [ConversationStatus, ...ConversationStatus[]];

const statusInput = z.object({
  conversationId: conversationArg,
  status: z.enum(statuses).describe('`closed` to close it, `open` to open a closed one again.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const noteInput = z.object({
  conversationId: conversationArg,
  body: z
    .string()
    .trim()
    .min(1)
    .max(MessengerLimits.bodyMax)
    .describe('The note, as the team will read it in the conversation. Plain text; the contact never sees it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const blockInput = z.object({
  contactId: z
    .uuid()
    .describe("The contact's id, as `mocco_messenger_conversation_get` or a search answer's `contact.id` gives it."),
  blocked: z.boolean().describe('`true` to stop them writing, `false` to let them write again.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type SetStatusArgs = z.infer<typeof statusInput>;
export type NoteArgs = z.infer<typeof noteInput>;
export type BlockArgs = z.infer<typeof blockInput>;

const statusWords: DecisionWords = {
  verb: 'close or reopen conversations',
  doing: 'Closing or reopening a conversation',
  scope: MESSENGER_WRITE,
  instead: 'close or reopen it from the conversation in the Mocco console',
};

const noteWords: DecisionWords = {
  verb: 'leave notes in the messenger',
  doing: 'Leaving a note',
  scope: MESSENGER_WRITE,
  instead: 'leave it from the Inbox in the Mocco console',
};

const blockWords: DecisionWords = {
  verb: 'block or unblock contacts',
  doing: 'Blocking or unblocking a contact',
  scope: MESSENGER_WRITE,
  instead: 'block or unblock them from their conversation in the Mocco console',
};

/** Close a conversation or open it again, as the caller, once they confirm. */
export async function setStatus(
  deps: MessengerConversationToolDeps,
  args: SetStatusArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, statusWords);
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
    if (conversation.status === args.status) {
      return asJson({
        changed: false,
        conversationId: conversation.id,
        status: conversation.status,
        reason: `It is ${conversation.status} already.`,
      });
    }
    const isClosing = args.status === ConversationStatuses.closed;
    const question = [
      `${isClosing ? 'Close' : 'Reopen'} this conversation with ${contactLabel(contact)}, as you?`,
      `Conversation: ${conversation.id} (${conversation.status} → ${args.status})`,
      isClosing
        ? 'It leaves the Open list. If they write again, it opens again by itself.'
        : 'It goes back to the Open list, with whoever has it now.',
    ].join('\n');
    // Bound to the status it was asked from: if anyone closes or reopens it meanwhile, ask again.
    const change = {
      tool: MESSENGER_SET_STATUS_TOOL,
      ...scope,
      conversationId: conversation.id,
      from: conversation.status,
      to: args.status,
    };
    return await confirmThenApply(ctx, confirmations, change, {
      label: isClosing ? 'Close this conversation' : 'Reopen this conversation',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await deps.messengerInbox.setStatus(scope.workspaceId, scope.projectId, userId, {
          conversationId: conversation.id,
          status: args.status,
        });
        return asJson({
          changed: true,
          conversationId: updated.id,
          status: updated.status,
          closedAt: updated.closedAt,
        });
      },
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

/** Leave an internal note in a conversation, as the caller, once they confirm the exact text. */
export async function createNote(
  deps: MessengerConversationToolDeps,
  args: NoteArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, noteWords);
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
    // As the reply: bound to the latest message when asked, so once the note is written (or
    // anyone writes) the same confirmation no longer matches.
    const change = {
      tool: MESSENGER_NOTE_TOOL,
      ...scope,
      conversationId: conversation.id,
      afterSeq: conversation.lastMessageSeq,
      body: args.body,
    };
    const question = [
      `Leave this note in the conversation with ${contactLabel(contact)}, as you?`,
      `Conversation: ${conversation.id} (${conversation.status})`,
      'Only your team sees it; the contact never does, and no one is notified.',
      '',
      args.body,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Leave this note',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const message = await deps.messengerInbox.write(scope.workspaceId, scope.projectId, userId, {
          conversationId: conversation.id,
          body: args.body,
          internal: true,
          clientMessageId: messageKeyOf(userId, change),
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

/** Block a contact, or let them write again, as the caller, once they confirm. */
export async function setBlocked(
  deps: MessengerConversationToolDeps,
  args: BlockArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, blockWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveMessengerProject(deps, userId, { workspaceId, projectId: args.projectId });
    const contact = await deps.messengerInbox.contact(scope.workspaceId, scope.projectId, args.contactId);
    const isBlocked = contact.blockedAt !== null;
    if (isBlocked === args.blocked) {
      return asJson({
        changed: false,
        contactId: contact.id,
        isBlocked,
        reason: isBlocked ? 'They are blocked already.' : 'They are not blocked.',
      });
    }
    const who = contactLabel(contact);
    const question = args.blocked
      ? [
          `Block ${who}, as you?`,
          `Contact: ${contact.id}`,
          'They can still read their conversations, but can no longer write or start a new one.',
        ]
      : [`Let ${who} write again, as you?`, `Contact: ${contact.id}`, 'They can write and start conversations again.'];
    // Bound to whether they were blocked when asked.
    const change = { tool: MESSENGER_BLOCK_TOOL, ...scope, contactId: contact.id, from: isBlocked, to: args.blocked };
    return await confirmThenApply(ctx, confirmations, change, {
      label: args.blocked ? 'Block this contact' : 'Unblock this contact',
      ask: async () => await Promise.resolve(question.join('\n')),
      apply: async () => {
        const updated = await deps.messengerInbox.setContactBlocked(scope.workspaceId, scope.projectId, userId, {
          contactId: contact.id,
          blocked: args.blocked,
        });
        return asJson({ changed: true, contactId: updated.id, isBlocked: updated.blockedAt !== null });
      },
    });
  } catch (error) {
    return messengerRefusal(error);
  }
}

export function registerMessengerConversationTools(server: McpServer, deps: MessengerConversationToolDeps): void {
  server.registerTool(
    MESSENGER_SET_STATUS_TOOL,
    {
      title: 'Close or reopen a messenger conversation',
      description:
        'Close a conversation (`closed`) or open a closed one again (`open`), as the signed-in person, exactly as the console does. A contact writing in a closed conversation opens it again by itself. The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.',
      inputSchema: statusInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireMessengerWrite('Closing or reopening'),
    },
    async (args, ctx) => await setStatus(deps, args, ctx),
  );

  server.registerTool(
    MESSENGER_NOTE_TOOL,
    {
      title: 'Leave an internal note in a messenger conversation',
      description:
        'Add an internal note to a conversation, as the signed-in person: the team sees it in the thread, the contact never does, and nothing is pushed. Text only. The person is asked to confirm the exact text in their client first, and it only works where the workspace allows agents to make changes. To write to the contact, use `mocco_messenger_reply`.',
      inputSchema: noteInput,
      // A confirmation answered twice still writes once.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: requireMessengerWrite('Leaving a note'),
    },
    async (args, ctx) => await createNote(deps, args, ctx),
  );

  server.registerTool(
    MESSENGER_BLOCK_TOOL,
    {
      title: 'Block or unblock a messenger contact',
      description:
        'Stop a contact writing to the team (`blocked: true`; they can still read what they have) or let them write again (`false`), as the signed-in person, exactly as the console does; recorded in the audit log. The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes. Erasing a contact stays in the console.',
      inputSchema: blockInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      scopeChallenge: requireMessengerWrite('Blocking or unblocking'),
    },
    async (args, ctx) => await setBlocked(deps, args, ctx),
  );
}
