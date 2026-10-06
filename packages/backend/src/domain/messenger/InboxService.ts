// The team's side of the messenger (#95): a project's inbox, a conversation with every
// message (internal notes included), replies and notes (with attachments, #430),
// open/closed, read positions, assigning by hand, and blocking a contact. Callers are workspace members, checked by the tRPC procedure;
// every query here is also scoped by workspace and project.
import { AuditActions } from '@mocco/common/audit';
import { AuthorKinds, MessageVisibilities, MessengerLimits } from '@mocco/common/messenger';

import {
  attachmentsByMessage,
  claimAttachments,
  prepareAttachments,
  reserveAttachment,
} from '@backend/domain/messenger/attachments';
import { eraseContact } from '@backend/domain/messenger/erase';
import {
  ContactNotFoundError,
  ConversationNotFoundError,
  InboxMemberNotFoundError,
  NotWorkspaceMemberError,
} from '@backend/domain/messenger/errors';
import { pushMessengerReply } from '@backend/domain/messenger/jobs';
import { MessengerContactRepo } from '@backend/domain/messenger/repos/contact.repo';
import { MessengerConversationRepo } from '@backend/domain/messenger/repos/conversation.repo';
import { MessengerInboxMemberRepo } from '@backend/domain/messenger/repos/inbox-member.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { AttachmentStorage } from '@backend/domain/messenger/attachments';
import type { InboxFilter } from '@backend/domain/messenger/repos/conversation.repo';
import type { Db } from '@backend/infra/db/types';
import type { AttachmentCreateInput, ConversationStatus } from '@mocco/common/messenger';

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

/** The contact a conversation's attachments are reserved for. */
const scopeOf = (conversation: { workspaceId: string; projectId: string; contactId: string }) => ({
  workspaceId: conversation.workspaceId,
  projectId: conversation.projectId,
  contactId: conversation.contactId,
});

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

  /**
   * The project's conversations, newest activity first, with unread state for `userId`:
   * those with `status` (open and closed alike without one), and optionally only one
   * assignee's, the unassigned, or one contact's. `limit` defaults to a page.
   */
  async list(workspaceId: string, projectId: string, userId: string, opts: InboxFilter & { limit?: number }) {
    const { limit, ...filter } = opts;
    const rows = await new MessengerConversationRepo(this.deps.db).inbox(workspaceId, projectId, userId, {
      ...filter,
      limit: limit ?? MessengerLimits.pageSize,
    });
    return rows.map(({ conversation, contact, lastReadSeq, assigneeName }) => ({
      id: conversation.id,
      status: conversation.status,
      category: conversation.category,
      assignee:
        conversation.assigneeUserId === null ? null : { userId: conversation.assigneeUserId, name: assigneeName },
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
    const { assigneeUserId } = conversation;
    return {
      conversation,
      contact,
      assignee:
        assigneeUserId === null
          ? null
          : { userId: assigneeUserId, name: (await conversations.assigneeName(assigneeUserId)) ?? null },
      messages: messages.map(({ message, authorName }) => ({
        ...message,
        authorName,
        attachments: attachments.get(message.id) ?? [],
      })),
    };
  }

  /**
   * Reserve an upload for a screenshot or a PDF to send in this conversation; name its
   * id in `write`. The same types, 10 MB limit and storage as a contact's upload. It
   * stays `userId`'s: only they can send it, and only in a conversation with this contact.
   */
  async createAttachment(
    workspaceId: string,
    projectId: string,
    userId: string,
    input: AttachmentCreateInput & { conversationId: string },
  ) {
    const { conversationId, ...file } = input;
    const conversation = await this.require(workspaceId, projectId, conversationId);
    return await reserveAttachment(this.deps.db, this.deps.storage, scopeOf(conversation), file, userId);
  }

  /** Reply to the contact (`internal: false`) or add a note only the team sees, with up to
   * three of the caller's own attachments (checked as a contact's are; see `prepareAttachments`).
   * A `clientMessageId` already in the conversation returns that message and sends nothing. */
  async write(
    workspaceId: string,
    projectId: string,
    userId: string,
    input: {
      conversationId: string;
      body: string;
      internal: boolean;
      attachmentIds?: readonly string[];
      clientMessageId?: string;
    },
  ) {
    const conversation = await this.require(workspaceId, projectId, input.conversationId);
    const attachmentIds = await prepareAttachments(
      this.deps.db,
      this.deps.storage,
      scopeOf(conversation),
      userId,
      input.attachmentIds,
    );
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
          clientMessageId: input.clientMessageId ?? null,
          context: null,
        },
        now,
        preview(input.body),
      );
      await claimAttachments(tx, attachmentIds, written.id);
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

  /** Who a conversation can be given to: a member of the workspace, with their name and email. */
  async assignable(workspaceId: string, userId: string) {
    const member = await new MessengerInboxMemberRepo(this.deps.db).findWorkspaceMember(workspaceId, userId);
    if (member === undefined) {
      throw new NotWorkspaceMemberError(userId);
    }
    return member;
  }

  /**
   * Give a conversation to a workspace member, or to no one (`assigneeUserId: null`), by
   * hand; round robin only assigns when a conversation starts. Audited as `actorUserId`.
   * Giving it to whoever has it already changes and records nothing.
   */
  async assign(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { conversationId: string; assigneeUserId: string | null },
  ) {
    const conversation = await this.require(workspaceId, projectId, input.conversationId);
    const assignee = input.assigneeUserId === null ? null : await this.assignable(workspaceId, input.assigneeUserId);
    const summary = assignee === null ? null : { userId: assignee.userId, name: assignee.name };
    if (conversation.assigneeUserId === input.assigneeUserId) {
      return { conversationId: conversation.id, assignee: summary, changed: false };
    }
    await new MessengerConversationRepo(this.deps.db).setAssignee(
      workspaceId,
      input.conversationId,
      input.assigneeUserId,
    );
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.messengerConversationAssigned,
      subjectType: 'messenger_conversation',
      subjectId: conversation.id,
      payload: { projectId, from: conversation.assigneeUserId, to: input.assigneeUserId },
    });
    return { conversationId: conversation.id, assignee: summary, changed: true };
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

  /** Who takes new conversations in the project's inbox, in round-robin order of joining. */
  async members(workspaceId: string, projectId: string) {
    return await new MessengerInboxMemberRepo(this.deps.db).list(workspaceId, projectId);
  }

  /** Put a workspace member in the rotation (available). Adding someone twice is a no-op. Audited. */
  async addMember(workspaceId: string, projectId: string, actorUserId: string, userId: string) {
    const repo = new MessengerInboxMemberRepo(this.deps.db);
    if (!(await repo.isWorkspaceMember(workspaceId, userId))) {
      throw new NotWorkspaceMemberError(userId);
    }
    const added = await repo.add({ workspaceId, projectId, userId, createdAt: this.now() });
    if (added !== undefined) {
      await this.deps.audit.record(workspaceId, {
        actorUserId,
        action: AuditActions.messengerInboxMemberAdded,
        subjectType: 'project',
        subjectId: projectId,
        payload: { userId },
      });
    }
  }

  /** Take someone out of the rotation. Conversations they already have stay theirs. Audited. */
  async removeMember(workspaceId: string, projectId: string, actorUserId: string, userId: string) {
    const removed = await new MessengerInboxMemberRepo(this.deps.db).remove(workspaceId, projectId, userId);
    if (removed === undefined) {
      throw new InboxMemberNotFoundError(userId);
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.messengerInboxMemberRemoved,
      subjectType: 'project',
      subjectId: projectId,
      payload: { userId },
    });
  }

  /** Mark a member available (round robin gives them new conversations) or away (it skips them). */
  async setAvailable(workspaceId: string, projectId: string, input: { userId: string; available: boolean }) {
    const updated = await new MessengerInboxMemberRepo(this.deps.db).setAvailable(
      workspaceId,
      projectId,
      input.userId,
      input.available,
    );
    if (updated === undefined) {
      throw new InboxMemberNotFoundError(input.userId);
    }
    return { available: updated.available };
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

  /** Erase a contact and everything they wrote (a privacy request). Can't be undone. */
  async eraseContact(workspaceId: string, projectId: string, actorUserId: string, contactId: string): Promise<void> {
    const contact = await new MessengerContactRepo(this.deps.db).find(workspaceId, projectId, contactId);
    if (contact === undefined) {
      throw new ContactNotFoundError(contactId);
    }
    await eraseContact(this.deps, contact);
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.messengerContactErased,
      subjectType: 'messenger_contact',
      subjectId: contact.id,
      payload: { projectId, by: 'operator' },
    });
  }
}
