// The contact's side of the messenger (/v1/messenger, #95): start a session for a user
// the app's server signed, then list, start and continue that user's conversations.
// Every query is scoped by the contact the session token resolves to, never by ids in
// the request body, so one user can never read another's conversations.
import { AuditActions } from '@mocco/common/audit';
import { MessengerEventTypes } from '@mocco/common/events';
import { AuthorKinds, MessageVisibilities, MessengerLimits } from '@mocco/common/messenger';
import { Products } from '@mocco/common/project';
import { Visibilities } from '@mocco/common/storage';

import { publishBestEffort } from '@backend/domain/events/ports';
import { attachmentsByMessage } from '@backend/domain/messenger/attachments';
import { eraseContact } from '@backend/domain/messenger/erase';
import {
  AttachmentNotFoundError,
  AttachmentsUnavailableError,
  ContactBlockedError,
  ConversationNotFoundError,
  GuestsNotAllowedError,
  IdentityVerificationError,
  UnknownCategoryError,
} from '@backend/domain/messenger/errors';
import { isUserHashValid, newGuestToken, newSessionToken, sessionTokenHash } from '@backend/domain/messenger/identity';
import { contactMessageEvent } from '@backend/domain/messenger/messages';
import { MessengerAttachmentRepo } from '@backend/domain/messenger/repos/attachment.repo';
import { MessengerContactRepo } from '@backend/domain/messenger/repos/contact.repo';
import { MessengerConversationRepo } from '@backend/domain/messenger/repos/conversation.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { AttachmentStorage } from '@backend/domain/messenger/attachments';
import type { MessengerSettingsService } from '@backend/domain/messenger/MessengerSettingsService';
import type { ContactRow } from '@backend/domain/messenger/repos/contact.repo';
import type { ConversationRow, MessageRow } from '@backend/domain/messenger/repos/conversation.repo';
import type { Db } from '@backend/infra/db/types';
import type {
  AttachmentCreateInput,
  AttachmentDto,
  ContactConversationDto,
  ContactMessageDto,
  ConversationCreateInput,
  MessageCreateInput,
  MessengerSessionDto,
  GuestSessionInput,
  IdentifiedSessionInput,
  MessengerSessionInput,
} from '@mocco/common/messenger';

/** Sessions last 30 days; the app makes a new one whenever it has a fresh user hash. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ContactMessengerDeps {
  db: Db;
  settings: Pick<MessengerSettingsService, 'withSecret'>;
  /** Records a user erasing themselves; without it, the erase isn't audited. */
  audit?: Pick<AuditService, 'record'>;
  /** Object storage for screenshots; without it, attachments are refused. */
  storage?: AttachmentStorage;
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

function toMessageDto(
  { message, authorName }: { message: MessageRow; authorName: string | null },
  attachments: AttachmentDto[] = [],
): ContactMessageDto {
  return {
    id: message.id,
    seq: message.seq,
    author: message.authorKind,
    authorName: message.authorKind === AuthorKinds.operator ? authorName : null,
    body: message.body,
    attachments,
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

  /**
   * The ids, verified: the contact's own unclaimed attachments, each with its bytes
   * uploaded as declared (storage checks size and type). Throws on any other id.
   */
  private async prepareAttachments(contact: ContactRow, ids: readonly string[] | undefined): Promise<string[]> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) {
      return [];
    }
    const { storage } = this.deps;
    if (storage === undefined) {
      throw new AttachmentsUnavailableError();
    }
    const rows = await new MessengerAttachmentRepo(this.deps.db).findUnclaimed(contact.workspaceId, contact.id, wanted);
    if (rows.length !== wanted.length) {
      throw new AttachmentNotFoundError();
    }
    await Promise.all(rows.map(async row => await storage.completeUpload(contact.workspaceId, row.objectId)));
    return wanted;
  }

  /** A signed-in user, verified by the app's server signature. A guest token from the same
   * device moves what they wrote as a guest to their account. */
  private async identifiedContact(
    project: { workspaceId: string; projectId: string },
    input: IdentifiedSessionInput,
    identitySecret: string,
    now: Date,
  ): Promise<{ contact: ContactRow; guestToken?: undefined }> {
    if (!isUserHashValid(identitySecret, input.userId, input.userHash)) {
      throw new IdentityVerificationError();
    }
    const contact = await this.deps.db.transaction(async tx => {
      const contacts = new MessengerContactRepo(tx);
      const signedIn = await contacts.upsert({
        ...project,
        externalUserId: input.userId,
        name: input.name ?? null,
        email: input.email ?? null,
        traits: input.traits ?? {},
        lastContext: input.context ?? {},
        lastSeenAt: now,
      });
      const guest =
        input.guestToken === undefined
          ? undefined
          : await contacts.findGuest(project.projectId, sessionTokenHash(input.guestToken));
      if (guest !== undefined && guest.blockedAt === null) {
        await contacts.mergeGuest(guest.id, signedIn.id);
      }
      return signedIn;
    });
    return { contact };
  }

  /** Someone not signed in, known by the email they left and their device's guest token. */
  private async guestContact(
    project: { workspaceId: string; projectId: string },
    input: GuestSessionInput,
    areGuestsAllowed: boolean,
    now: Date,
  ): Promise<{ contact: ContactRow; guestToken?: string }> {
    if (!areGuestsAllowed) {
      throw new GuestsNotAllowedError();
    }
    const contacts = new MessengerContactRepo(this.deps.db);
    const returning =
      input.guestToken === undefined
        ? undefined
        : await contacts.findGuest(project.projectId, sessionTokenHash(input.guestToken));
    const details = { email: input.email, name: input.name ?? null, lastContext: input.context ?? {}, lastSeenAt: now };
    if (returning !== undefined) {
      return { contact: await contacts.refreshGuest(returning.id, details) };
    }
    const { token, hash } = newGuestToken();
    const contact = await contacts.insertGuest({ ...project, ...details, guestTokenHash: hash });
    return { contact, guestToken: token };
  }

  /** Verify the app's signature on the user id, refresh the contact, and issue a session. */
  async createSession(
    project: { workspaceId: string; projectId: string },
    input: MessengerSessionInput,
  ): Promise<MessengerSessionDto> {
    const settings = await this.deps.settings.withSecret(project.workspaceId, project.projectId);
    const now = this.now();
    const { contact, guestToken } =
      'guest' in input
        ? await this.guestContact(project, input, settings.allowGuests, now)
        : await this.identifiedContact(project, input, settings.identitySecret, now);
    if (contact.blockedAt !== null) {
      throw new ContactBlockedError();
    }
    const { token, hash } = newSessionToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await new MessengerContactRepo(this.deps.db).insertSession({
      workspaceId: project.workspaceId,
      contactId: contact.id,
      tokenHash: hash,
      expiresAt,
    });
    return {
      sessionToken: token,
      expiresAt: expiresAt.toISOString(),
      contactId: contact.id,
      categories: settings.categories,
      ...(guestToken !== undefined && { guestToken }),
    };
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
    // A retried create returns the conversation its first message already started.
    const started = await new MessengerConversationRepo(this.deps.db).findStartedBy(
      contact.workspaceId,
      contact.id,
      input.clientMessageId,
    );
    if (started !== undefined) {
      return toConversationDto(started);
    }
    const attachmentIds = await this.prepareAttachments(contact, input.attachmentIds);
    const now = this.now();
    const result = await this.deps.db.transaction(async tx => {
      const repo = new MessengerConversationRepo(tx);
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
      const { message } = await repo.append(
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
      await new MessengerAttachmentRepo(tx).claim(attachmentIds, message.id);
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

  /** Reserve an upload for a screenshot; send its id with the message that carries it. */
  async createAttachment(principal: ContactPrincipal, input: AttachmentCreateInput) {
    const { contact } = principal;
    requireActive(contact);
    const { storage } = this.deps;
    if (storage === undefined) {
      throw new AttachmentsUnavailableError();
    }
    const { object, upload } = await storage.beginUpload({
      workspaceId: contact.workspaceId,
      projectId: contact.projectId,
      product: Products.messenger,
      filename: input.filename ?? 'screenshot',
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      visibility: Visibilities.private,
    });
    const attachment = await new MessengerAttachmentRepo(this.deps.db).insert({
      workspaceId: contact.workspaceId,
      contactId: contact.id,
      objectId: object.id,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    });
    return { attachmentId: attachment.id, upload };
  }

  /** Public messages after `afterSeq`, oldest first. */
  async messages(principal: ContactPrincipal, conversationId: string, afterSeq: number): Promise<ContactMessageDto[]> {
    await this.requireConversation(principal, conversationId);
    const rows = await new MessengerConversationRepo(this.deps.db).messages(conversationId, {
      afterSeq,
      limit: MessengerLimits.pageSize,
      publicOnly: true,
    });
    const attachments = await attachmentsByMessage(
      this.deps.db,
      this.deps.storage,
      principal.contact.workspaceId,
      rows.map(row => row.message.id),
    );
    return rows.map(row => toMessageDto(row, attachments.get(row.message.id)));
  }

  /** Write in an existing conversation (reopens a closed one). Idempotent on `clientMessageId`. */
  async send(principal: ContactPrincipal, conversationId: string, input: MessageCreateInput) {
    const { contact } = principal;
    requireActive(contact);
    const conversation = await this.requireConversation(principal, conversationId);
    // A retried send returns the message already stored.
    const sent = await new MessengerConversationRepo(this.deps.db).findByClientMessageId(
      conversationId,
      input.clientMessageId,
    );
    if (sent !== undefined) {
      const stored = await attachmentsByMessage(this.deps.db, this.deps.storage, contact.workspaceId, [sent.id]);
      return toMessageDto({ message: sent, authorName: null }, stored.get(sent.id));
    }
    const attachmentIds = await this.prepareAttachments(contact, input.attachmentIds);
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
      if (appended.created) {
        await new MessengerAttachmentRepo(tx).claim(attachmentIds, appended.message.id);
      }
      await repo.markContactRead(conversationId, appended.message.seq);
      return appended;
    });
    await new MessengerContactRepo(this.deps.db).touch(contact.id, input.context, now);
    if (created) {
      await this.announce(MessengerEventTypes.messengerMessageReceived, contact, conversation, input.body);
    }
    const attachments = await attachmentsByMessage(this.deps.db, this.deps.storage, contact.workspaceId, [message.id]);
    return toMessageDto({ message, authorName: null }, attachments.get(message.id));
  }

  async markRead(principal: ContactPrincipal, conversationId: string, seq: number): Promise<void> {
    await this.requireConversation(principal, conversationId);
    await new MessengerConversationRepo(this.deps.db).markContactRead(conversationId, seq);
  }

  /** The user erases themselves: every conversation, message and attachment they have
   * (an app's "delete my account"). The session goes too. */
  async erase(principal: ContactPrincipal): Promise<void> {
    const { contact } = principal;
    await eraseContact(this.deps, contact);
    await this.deps.audit?.record(contact.workspaceId, {
      actorUserId: null,
      action: AuditActions.messengerContactErased,
      subjectType: 'messenger_contact',
      subjectId: contact.id,
      payload: { projectId: contact.projectId, by: 'contact' },
    });
  }
}
