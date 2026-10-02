import { and, eq, gt, isNull } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { MessengerContext } from '@mocco/common/messenger';

export type ContactRow = typeof schema.messengerContacts.$inferSelect;

const c = schema.messengerContacts;
const sessions = schema.messengerSessions;

/** Data access for mocco_messenger_contacts and their sessions. Scoped by workspace. */
export class MessengerContactRepo {
  constructor(private readonly db: Db) {}

  /** Create or refresh the contact for the app's user id (what the app last said wins). */
  async upsert(row: {
    workspaceId: string;
    projectId: string;
    externalUserId: string;
    name: string | null;
    email: string | null;
    traits: Record<string, string | number | boolean>;
    lastContext: MessengerContext;
    lastSeenAt: Date;
  }): Promise<ContactRow> {
    return expectOne(
      await this.db
        .insert(c)
        .values(row)
        .onConflictDoUpdate({
          target: [c.projectId, c.externalUserId],
          set: {
            name: row.name,
            email: row.email,
            traits: row.traits,
            lastContext: row.lastContext,
            lastSeenAt: row.lastSeenAt,
          },
        })
        .returning(),
    );
  }

  async insertGuest(row: {
    workspaceId: string;
    projectId: string;
    email: string;
    name: string | null;
    guestTokenHash: string;
    lastContext: MessengerContext;
    lastSeenAt: Date;
  }): Promise<ContactRow> {
    return expectOne(
      await this.db
        .insert(c)
        .values({ ...row, externalUserId: null, traits: {} })
        .returning(),
    );
  }

  /** The project's guest with this device token hash. */
  async findGuest(projectId: string, guestTokenHash: string) {
    const [row] = await this.db
      .select()
      .from(c)
      .where(and(eq(c.projectId, projectId), eq(c.guestTokenHash, guestTokenHash), isNull(c.externalUserId)));
    return row;
  }

  /** A returning guest: what they said about themselves now wins. */
  async refreshGuest(
    contactId: string,
    values: { email: string; name: string | null; lastContext: MessengerContext; lastSeenAt: Date },
  ) {
    return expectOne(await this.db.update(c).set(values).where(eq(c.id, contactId)).returning());
  }

  /**
   * Move a guest's conversations, attachments and devices to a signed-in contact, then
   * delete the guest (its sessions go with it). Call in a transaction.
   */
  async mergeGuest(guestId: string, contactId: string): Promise<void> {
    await this.db
      .update(schema.messengerConversations)
      .set({ contactId })
      .where(eq(schema.messengerConversations.contactId, guestId));
    await this.db
      .update(schema.messengerAttachments)
      .set({ contactId })
      .where(eq(schema.messengerAttachments.contactId, guestId));
    await this.db
      .update(schema.messengerPushTokens)
      .set({ contactId })
      .where(eq(schema.messengerPushTokens.contactId, guestId));
    await this.db.delete(c).where(eq(c.id, guestId));
  }

  async find(workspaceId: string, projectId: string, contactId: string) {
    const [row] = await this.db
      .select()
      .from(c)
      .where(and(eq(c.id, contactId), eq(c.workspaceId, workspaceId), eq(c.projectId, projectId)));
    return row;
  }

  async touch(contactId: string, context: MessengerContext | undefined, now: Date) {
    await this.db
      .update(c)
      .set({ lastSeenAt: now, ...(context !== undefined && { lastContext: context }) })
      .where(eq(c.id, contactId));
  }

  async setBlocked(workspaceId: string, projectId: string, contactId: string, blockedAt: Date | null) {
    const [row] = await this.db
      .update(c)
      .set({ blockedAt })
      .where(and(eq(c.id, contactId), eq(c.workspaceId, workspaceId), eq(c.projectId, projectId)))
      .returning();
    return row;
  }

  async insertSession(row: typeof sessions.$inferInsert) {
    return expectOne(await this.db.insert(sessions).values(row).returning());
  }

  /** The live session for a token hash, with its contact. */
  async findSession(tokenHash: string, now: Date) {
    const [row] = await this.db
      .select({ session: sessions, contact: c })
      .from(sessions)
      .innerJoin(c, and(eq(c.id, sessions.contactId), eq(c.workspaceId, sessions.workspaceId)))
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)));
    return row;
  }

  async revokeSession(sessionId: string, now: Date) {
    await this.db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, sessionId));
  }
}
