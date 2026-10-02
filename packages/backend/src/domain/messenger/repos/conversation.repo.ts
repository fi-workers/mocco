import { MessageVisibilities } from '@mocco/common/messenger';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { AuthorKind, ConversationStatus, MessageVisibility, MessengerContext } from '@mocco/common/messenger';

export type ConversationRow = typeof schema.messengerConversations.$inferSelect;
export type MessageRow = typeof schema.messengerMessages.$inferSelect;

const conv = schema.messengerConversations;
const msg = schema.messengerMessages;
const reads = schema.messengerOperatorReads;
const contacts = schema.messengerContacts;

export interface NewMessage {
  authorKind: AuthorKind;
  authorUserId: string | null;
  visibility: MessageVisibility;
  body: string;
  clientMessageId: string | null;
  context: MessengerContext | null;
}

/** Data access for conversations, their messages and read positions. Scoped by workspace. */
export class MessengerConversationRepo {
  constructor(private readonly db: Db) {}

  async create(row: typeof conv.$inferInsert): Promise<ConversationRow> {
    return expectOne(await this.db.insert(conv).values(row).returning());
  }

  /**
   * Append a message, numbering it with the conversation's next seq. Call inside a
   * transaction: the `UPDATE … RETURNING` row lock serializes concurrent sends, and the
   * unique (conversation, seq) index is the backstop. A repeated `clientMessageId`
   * returns the stored message (`created: false`) and changes nothing.
   */
  async append(
    workspaceId: string,
    conversationId: string,
    message: NewMessage,
    now: Date,
    preview: string,
  ): Promise<{ message: MessageRow; created: boolean }> {
    if (message.clientMessageId !== null) {
      const [existing] = await this.db
        .select()
        .from(msg)
        .where(and(eq(msg.conversationId, conversationId), eq(msg.clientMessageId, message.clientMessageId)));
      if (existing !== undefined) {
        return { message: existing, created: false };
      }
    }
    const isPublic = message.visibility === MessageVisibilities.public;
    const isFromTeam = message.authorKind !== 'contact';
    const [numbered] = await this.db
      .update(conv)
      .set({
        lastMessageSeq: sql`${conv.lastMessageSeq} + 1`,
        ...(isPublic && { lastMessageAt: now, preview }),
        ...(isPublic && isFromTeam && { lastOperatorSeq: sql`${conv.lastMessageSeq} + 1` }),
        // The contact writing again reopens a closed conversation.
        ...(!isFromTeam && { status: 'open', closedAt: null }),
      })
      .where(and(eq(conv.id, conversationId), eq(conv.workspaceId, workspaceId)))
      .returning({ seq: conv.lastMessageSeq });
    if (numbered === undefined) {
      throw new Error(`Conversation ${conversationId} is gone`);
    }
    const inserted = expectOne(
      await this.db
        .insert(msg)
        .values({ ...message, workspaceId, conversationId, seq: numbered.seq, createdAt: now })
        .returning(),
    );
    return { message: inserted, created: true };
  }

  async listForContact(workspaceId: string, contactId: string, limit: number) {
    return await this.db
      .select()
      .from(conv)
      .where(and(eq(conv.workspaceId, workspaceId), eq(conv.contactId, contactId)))
      .orderBy(desc(conv.lastMessageAt))
      .limit(limit);
  }

  async findForContact(workspaceId: string, contactId: string, conversationId: string) {
    const [row] = await this.db
      .select()
      .from(conv)
      .where(and(eq(conv.id, conversationId), eq(conv.workspaceId, workspaceId), eq(conv.contactId, contactId)));
    return row;
  }

  /** The message with this client id in a conversation (a retried send). */
  async findByClientMessageId(conversationId: string, clientMessageId: string) {
    const [row] = await this.db
      .select()
      .from(msg)
      .where(and(eq(msg.conversationId, conversationId), eq(msg.clientMessageId, clientMessageId)));
    return row;
  }

  /** The contact's conversation whose message has this client id (a retried start). */
  async findStartedBy(workspaceId: string, contactId: string, clientMessageId: string) {
    const [row] = await this.db
      .select({ conversation: conv })
      .from(msg)
      .innerJoin(conv, and(eq(conv.id, msg.conversationId), eq(conv.workspaceId, msg.workspaceId)))
      .where(
        and(eq(msg.workspaceId, workspaceId), eq(conv.contactId, contactId), eq(msg.clientMessageId, clientMessageId)),
      );
    return row?.conversation;
  }

  async findInProject(workspaceId: string, projectId: string, conversationId: string) {
    const [row] = await this.db
      .select()
      .from(conv)
      .where(and(eq(conv.id, conversationId), eq(conv.workspaceId, workspaceId), eq(conv.projectId, projectId)));
    return row;
  }

  /** Messages after `afterSeq`, oldest first; `publicOnly` for the contact's view. */
  async messages(conversationId: string, opts: { afterSeq: number; limit: number; publicOnly: boolean }) {
    return await this.db
      .select({ message: msg, authorName: schema.users.name })
      .from(msg)
      .leftJoin(schema.users, eq(schema.users.id, msg.authorUserId))
      .where(
        and(
          eq(msg.conversationId, conversationId),
          gt(msg.seq, opts.afterSeq),
          ...(opts.publicOnly ? [eq(msg.visibility, MessageVisibilities.public)] : []),
        ),
      )
      .orderBy(asc(msg.seq))
      .limit(opts.limit);
  }

  /** Move the contact's read position forward (never back, never past the last message). */
  async markContactRead(conversationId: string, seq: number) {
    await this.db
      .update(conv)
      .set({ contactLastReadSeq: sql`greatest(${conv.contactLastReadSeq}, least(${seq}, ${conv.lastMessageSeq}))` })
      .where(eq(conv.id, conversationId));
  }

  async setStatus(workspaceId: string, conversationId: string, status: ConversationStatus, now: Date) {
    return expectOne(
      await this.db
        .update(conv)
        .set({ status, closedAt: status === 'closed' ? now : null })
        .where(and(eq(conv.id, conversationId), eq(conv.workspaceId, workspaceId)))
        .returning(),
    );
  }

  async markOperatorRead(workspaceId: string, conversationId: string, userId: string, seq: number) {
    await this.db
      .insert(reads)
      .values({ workspaceId, conversationId, userId, lastReadSeq: seq })
      .onConflictDoUpdate({
        target: [reads.conversationId, reads.userId],
        set: { lastReadSeq: sql`greatest(${reads.lastReadSeq}, excluded.last_read_seq)` },
      });
  }

  /**
   * A project's inbox, newest activity first, with each conversation's contact and
   * the caller's read position. Keyset-paged by `before` (a last_message_at).
   */
  async inbox(
    workspaceId: string,
    projectId: string,
    userId: string,
    opts: { status: ConversationStatus; before?: Date; limit: number },
  ) {
    return await this.db
      .select({
        conversation: conv,
        contact: {
          id: contacts.id,
          name: contacts.name,
          email: contacts.email,
          externalUserId: contacts.externalUserId,
        },
        lastReadSeq: reads.lastReadSeq,
      })
      .from(conv)
      .innerJoin(contacts, and(eq(contacts.id, conv.contactId), eq(contacts.workspaceId, conv.workspaceId)))
      .leftJoin(reads, and(eq(reads.conversationId, conv.id), eq(reads.userId, userId)))
      .where(
        and(
          eq(conv.workspaceId, workspaceId),
          eq(conv.projectId, projectId),
          eq(conv.status, opts.status),
          ...(opts.before === undefined ? [] : [lt(conv.lastMessageAt, opts.before)]),
        ),
      )
      .orderBy(desc(conv.lastMessageAt))
      .limit(opts.limit);
  }
}
