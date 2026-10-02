// The contact's side of the messenger (/v1/messenger, #95): start a session for a user
// the app's server signed, then list, start and continue that user's conversations.
// Every query is scoped by the contact the session token resolves to, never by ids in
// the request body, so one user can never read another's conversations.
import { MessengerEventTypes } from '@mocco/common/events';
import { AuthorKinds, MessageVisibilities, MessengerLimits } from '@mocco/common/messenger';

import { publishBestEffort } from '@backend/domain/events/ports';
import {
  ContactBlockedError,
  ConversationNotFoundError,
  IdentityVerificationError,
  UnknownCategoryError,
} from '@backend/domain/messenger/errors';
import { isUserHashValid, newSessionToken, sessionTokenHash } from '@backend/domain/messenger/identity';
import { contactMessageEvent } from '@backend/domain/messenger/messages';
import { MessengerContactRepo } from '@backend/domain/messenger/repos/contact.repo';
import { MessengerConversationRepo } from '@backend/domain/messenger/repos/conversation.repo';

import type { EventPublisher } from '@backend/domain/events/ports';
import type { MessengerSettingsService } from '@backend/domain/messenger/MessengerSettingsService';
import type { ContactRow } from '@backend/domain/messenger/repos/contact.repo';
import type { ConversationRow, MessageRow } from '@backend/domain/messenger/repos/conversation.repo';
import type { Db } from '@backend/infra/db/types';
import type {
  ContactConversationDto,
  ContactMessageDto,
  ConversationCreateInput,
  MessageCreateInput,
  MessengerSessionDto,
  MessengerSessionInput,
} from '@mocco/common/messenger';

/** Sessions last 30 days; the app makes a new one whenever it has a fresh user hash. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ContactMessengerDeps {
  db: Db;
  settings: Pick<MessengerSettingsService, 'withSecret'>;
  events?: EventPublisher;
  appOrigin?: string;
  now?: () => Date;
}

/** Who a session token speaks for. */
export interface ContactPrincipal {
  sessionId: string;
  contact: ContactRow;
}

// eslint-disable-next-line sonarjs/null-dereference -- body is a string, never null
const preview = (body: string) => body.replaceAll(/\s+/gu, ' ').slice(0, MessengerLimits.previewMax);

function requireActive(contact: ContactRow) {
  if (contact.blockedAt !== null) {
    throw new ContactBlockedError();
  }
}

function toConversationDto(row: ConversationRow): ContactConversationDto {
  return {
    id: row.id,
    status: row.status,
    category: row.category,
    preview: row.preview,
    lastMessageSeq: row.lastMessageSeq,
    lastMessageAt: row.lastMessageAt.toISOString(),
    hasUnread: row.lastOperatorSeq > row.contactLastReadSeq,
    createdAt: row.createdAt.toISOString(),
  };
}

function toMessageDto({ message, authorName }: { message: MessageRow; authorName: string | null }): ContactMessageDto {
  return {
    id: message.id,
    seq: message.seq,
    author: message.authorKind,
    authorName: message.authorKind === AuthorKinds.operator ? authorName : null,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}

export class ContactMessengerService {
  private readonly now: () => Date;

  constructor(private readonly deps: ContactMessengerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async requireConversation(principal: ContactPrincipal, conversationId: string) {
    const conversation = await new MessengerConversationRepo(this.deps.db).findForContact(
      principal.contact.workspaceId,
      principal.contact.id,
      conversationId,
    );
    if (conversation === undefined) {
      throw new ConversationNotFoundError(conversationId);
    }
    return conversation;
  }

  private async announce(
    type: (typeof MessengerEventTypes)[keyof typeof MessengerEventTypes],
    contact: ContactRow,
    conversation: ConversationRow,
    body: string,
  ) {
    const { events } = this.deps;
    if (events === undefined) {
      return;
    }
    await publishBestEffort(events, type, async () => {
      await Promise.resolve();
      return contactMessageEvent(type, { contact, conversation, body }, this.deps.appOrigin);
    });
  }

  /** Verify the app's signature on the user id, refresh the contact, and issue a session. */
  async createSession(
    project: { workspaceId: string; projectId: string },
    input: MessengerSessionInput,
  ): Promise<MessengerSessionDto> {
    const { identitySecret, categories } = await this.deps.settings.withSecret(project.workspaceId, project.projectId);
    if (!isUserHashValid(identitySecret, input.userId, input.userHash)) {
      throw new IdentityVerificationError();
    }
    const now = this.now();
    const contacts = new MessengerContactRepo(this.deps.db);
    const contact = await contacts.upsert({
      ...project,
      externalUserId: input.userId,
      name: input.name ?? null,
      email: input.email ?? null,
      traits: input.traits ?? {},
      lastContext: input.context ?? {},
      lastSeenAt: now,
    });
    if (contact.blockedAt !== null) {
      throw new ContactBlockedError();
    }
    const { token, hash } = newSessionToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await contacts.insertSession({
      workspaceId: project.workspaceId,
      contactId: contact.id,
      tokenHash: hash,
      expiresAt,
    });
    return { sessionToken: token, expiresAt: expiresAt.toISOString(), contactId: contact.id, categories };
  }

  /** The contact a session token speaks for, or undefined (unknown, revoked or expired). */
  async authenticate(token: string): Promise<ContactPrincipal | undefined> {
    const found = await new MessengerContactRepo(this.deps.db).findSession(sessionTokenHash(token), this.now());
    return found === undefined ? undefined : { sessionId: found.session.id, contact: found.contact };
  }

  async listConversations(principal: ContactPrincipal): Promise<ContactConversationDto[]> {
    const rows = await new MessengerConversationRepo(this.deps.db).listForContact(
      principal.contact.workspaceId,
      principal.contact.id,
      MessengerLimits.pageSize,
    );
    return rows.map(row => toConversationDto(row));
  }

  /** Start a conversation with its first message. Idempotent on `clientMessageId`. */
  async startConversation(principal: ContactPrincipal, input: ConversationCreateInput) {
    const { contact } = principal;
    requireActive(contact);
    const { categories } = await this.deps.settings.withSecret(contact.workspaceId, contact.projectId);
    if (input.category !== undefined && categories.every(category => category.key !== input.category)) {
      throw new UnknownCategoryError(input.category);
    }
    const now = this.now();
    const result = await this.deps.db.transaction(async tx => {
      const repo = new MessengerConversationRepo(tx);
      // A retried create returns the conversation its first message already started.
      const started = await repo.findStartedBy(contact.workspaceId, contact.id, input.clientMessageId);
      if (started !== undefined) {
        return { conversation: started, created: false };
      }
      const conversation = await repo.create({
        workspaceId: contact.workspaceId,
        projectId: contact.projectId,
        contactId: contact.id,
        status: 'open',
        category: input.category ?? null,
        lastMessageAt: now,
        preview: preview(input.body),
        contextAtOpen: input.context ?? contact.lastContext,
        createdAt: now,
      });
      await repo.append(
        contact.workspaceId,
        conversation.id,
        {
          authorKind: AuthorKinds.contact,
          authorUserId: null,
          visibility: MessageVisibilities.public,
          body: input.body,
          clientMessageId: input.clientMessageId,
          context: input.context ?? null,
        },
        now,
        preview(input.body),
      );
      // The contact has read their own first message.
      await repo.markContactRead(conversation.id, 1);
      const fresh = await repo.findForContact(contact.workspaceId, contact.id, conversation.id);
      return { conversation: fresh ?? conversation, created: true };
    });
    await new MessengerContactRepo(this.deps.db).touch(contact.id, input.context, now);
    if (result.created) {
      await this.announce(MessengerEventTypes.messengerConversationCreated, contact, result.conversation, input.body);
    }
    return toConversationDto(result.conversation);
  }

  /** Public messages after `afterSeq`, oldest first. */
  async messages(principal: ContactPrincipal, conversationId: string, afterSeq: number): Promise<ContactMessageDto[]> {
    await this.requireConversation(principal, conversationId);
    const rows = await new MessengerConversationRepo(this.deps.db).messages(conversationId, {
      afterSeq,
      limit: MessengerLimits.pageSize,
      publicOnly: true,
    });
    return rows.map(row => toMessageDto(row));
  }

  /** Write in an existing conversation (reopens a closed one). Idempotent on `clientMessageId`. */
  async send(principal: ContactPrincipal, conversationId: string, input: MessageCreateInput) {
    const { contact } = principal;
    requireActive(contact);
    const conversation = await this.requireConversation(principal, conversationId);
    const now = this.now();
    const { message, created } = await this.deps.db.transaction(async tx => {
      const repo = new MessengerConversationRepo(tx);
      const appended = await repo.append(
        contact.workspaceId,
        conversationId,
        {
          authorKind: AuthorKinds.contact,
          authorUserId: null,
          visibility: MessageVisibilities.public,
          body: input.body,
          clientMessageId: input.clientMessageId,
          context: input.context ?? null,
        },
        now,
        preview(input.body),
      );
      await repo.markContactRead(conversationId, appended.message.seq);
      return appended;
    });
    await new MessengerContactRepo(this.deps.db).touch(contact.id, input.context, now);
    if (created) {
      await this.announce(MessengerEventTypes.messengerMessageReceived, contact, conversation, input.body);
    }
    return toMessageDto({ message, authorName: null });
  }

  async markRead(principal: ContactPrincipal, conversationId: string, seq: number): Promise<void> {
    await this.requireConversation(principal, conversationId);
    await new MessengerConversationRepo(this.deps.db).markContactRead(conversationId, seq);
  }
}
