// The team's side of the messenger (#95): a project's inbox, a conversation with every
// message (internal notes included), replies, notes, open/closed, read positions, and
// blocking a contact. Callers are workspace members, checked by the tRPC procedure;
// every query here is also scoped by workspace and project.
import { AuditActions } from '@mocco/common/audit';
import { AuthorKinds, MessageVisibilities, MessengerLimits } from '@mocco/common/messenger';

import { attachmentsByMessage } from '@backend/domain/messenger/attachments';
import { ContactNotFoundError, ConversationNotFoundError } from '@backend/domain/messenger/errors';
import { pushMessengerReply } from '@backend/domain/messenger/jobs';
import { MessengerContactRepo } from '@backend/domain/messenger/repos/contact.repo';
import { MessengerConversationRepo } from '@backend/domain/messenger/repos/conversation.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { AttachmentStorage } from '@backend/domain/messenger/attachments';
import type { Db } from '@backend/infra/db/types';
import type { ConversationStatus } from '@mocco/common/messenger';

export interface InboxDeps {
  db: Db;
  audit: AuditService;
  storage?: AttachmentStorage;
  /** Queues the push for a reply; without it, replies aren't pushed. */
  queue?: Pick<JobQueue, 'enqueue' | 'kick'>;
  now?: () => Date;
}

// eslint-disable-next-line sonarjs/null-dereference -- body is a string, never null
const preview = (body: string) => body.replaceAll(/\s+/gu, ' ').slice(0, MessengerLimits.previewMax);

export class InboxService {
  private readonly now: () => Date;

  constructor(private readonly deps: InboxDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async require(workspaceId: string, projectId: string, conversationId: string) {
    const conversation = await new MessengerConversationRepo(this.deps.db).findInProject(
      workspaceId,
      projectId,
      conversationId,
    );
    if (conversation === undefined) {
      throw new ConversationNotFoundError(conversationId);
    }
    return conversation;
  }

  /** The project's conversations with `status`, newest activity first, with unread state for `userId`. */
  async list(
    workspaceId: string,
    projectId: string,
    userId: string,
    opts: { status: ConversationStatus; before?: Date },
  ) {
    const rows = await new MessengerConversationRepo(this.deps.db).inbox(workspaceId, projectId, userId, {
      ...opts,
      limit: MessengerLimits.pageSize,
    });
    return rows.map(({ conversation, contact, lastReadSeq }) => ({
      id: conversation.id,
      status: conversation.status,
      category: conversation.category,
      preview: conversation.preview,
      lastMessageAt: conversation.lastMessageAt,
      createdAt: conversation.createdAt,
      isUnread: conversation.lastMessageSeq > (lastReadSeq ?? 0),
      contact,
    }));
  }

  /** A conversation with all its messages and its contact, for the conversation view. */
  async get(workspaceId: string, projectId: string, conversationId: string) {
    const conversations = new MessengerConversationRepo(this.deps.db);
    const conversation = await this.require(workspaceId, projectId, conversationId);
    const contact = await new MessengerContactRepo(this.deps.db).find(workspaceId, projectId, conversation.contactId);
    if (contact === undefined) {
      throw new ConversationNotFoundError(conversationId);
    }
    const messages = await conversations.messages(conversationId, { afterSeq: 0, limit: 500, publicOnly: false });
    const attachments = await attachmentsByMessage(
      this.deps.db,
      this.deps.storage,
      workspaceId,
      messages.map(({ message }) => message.id),
    );
    return {
      conversation,
      contact,
      messages: messages.map(({ message, authorName }) => ({
        ...message,
        authorName,
        attachments: attachments.get(message.id) ?? [],
      })),
    };
  }

  /** Reply to the contact (`internal: false`) or add a note only the team sees. */
  async write(
    workspaceId: string,
    projectId: string,
    userId: string,
    input: { conversationId: string; body: string; internal: boolean },
  ) {
    await this.require(workspaceId, projectId, input.conversationId);
    const now = this.now();
    const { message, pushJobId } = await this.deps.db.transaction(async tx => {
      const repo = new MessengerConversationRepo(tx);
      const { message: written } = await repo.append(
        workspaceId,
        input.conversationId,
        {
          authorKind: AuthorKinds.operator,
          authorUserId: userId,
          visibility: input.internal ? MessageVisibilities.internal : MessageVisibilities.public,
          body: input.body,
          clientMessageId: null,
          context: null,
        },
        now,
        preview(input.body),
      );
      // Writing means having read up to here.
      await repo.markOperatorRead(workspaceId, input.conversationId, userId, written.seq);
      const queued = input.internal
        ? undefined
        : await this.deps.queue?.enqueue(
            pushMessengerReply,
            { conversationId: input.conversationId, seq: written.seq },
            { dedupeKey: `${input.conversationId}:${written.seq}`, workspaceId, executor: tx },
          );
      return { message: written, pushJobId: queued?.job.id };
    });
    // Push at once, once the reply is committed; the job table is the fallback.
    if (pushJobId !== undefined) {
      this.deps.queue?.kick(pushJobId);
    }
    return message;
  }

  async setStatus(workspaceId: string, projectId: string, conversationId: string, status: ConversationStatus) {
    await this.require(workspaceId, projectId, conversationId);
    return await new MessengerConversationRepo(this.deps.db).setStatus(workspaceId, conversationId, status, this.now());
  }

  async markRead(workspaceId: string, projectId: string, userId: string, conversationId: string) {
    const conversation = await this.require(workspaceId, projectId, conversationId);
    await new MessengerConversationRepo(this.deps.db).markOperatorRead(
      workspaceId,
      conversationId,
      userId,
      conversation.lastMessageSeq,
    );
  }

  /** Stop a contact writing (they can still read what they have), or let them again. Audited. */
  async setContactBlocked(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { contactId: string; blocked: boolean },
  ) {
    const contact = await new MessengerContactRepo(this.deps.db).setBlocked(
      workspaceId,
      projectId,
      input.contactId,
      input.blocked ? this.now() : null,
    );
    if (contact === undefined) {
      throw new ContactNotFoundError(input.contactId);
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.messengerContactBlocked,
      subjectType: 'messenger_contact',
      subjectId: contact.id,
      payload: { blocked: input.blocked },
    });
    return contact;
  }
}
