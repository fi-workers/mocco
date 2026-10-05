import { and, eq, inArray, isNull } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type AttachmentRow = typeof schema.messengerAttachments.$inferSelect;

const a = schema.messengerAttachments;

/** Data access for mocco_messenger_attachments. Scoped by workspace and contact. */
export class MessengerAttachmentRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof a.$inferInsert): Promise<AttachmentRow> {
    return expectOne(await this.db.insert(a).values(row).returning());
  }

  /** The contact's attachments among `ids` that no message has claimed yet. */
  async findUnclaimed(workspaceId: string, contactId: string, ids: readonly string[]): Promise<AttachmentRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(a)
      .where(
        and(eq(a.workspaceId, workspaceId), eq(a.contactId, contactId), inArray(a.id, [...ids]), isNull(a.messageId)),
      );
  }

  /** Attach them to a message; answers how many were still unclaimed (a concurrent
   * send may have taken one). Call in the message's transaction. */
  async claim(ids: readonly string[], messageId: string): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const claimed = await this.db
      .update(a)
      .set({ messageId })
      .where(and(inArray(a.id, [...ids]), isNull(a.messageId)))
      .returning({ id: a.id });
    return claimed.length;
  }

  async delete(workspaceId: string, ids: readonly string[]): Promise<void> {
    if (ids.length > 0) {
      await this.db.delete(a).where(and(eq(a.workspaceId, workspaceId), inArray(a.id, [...ids])));
    }
  }

  /** The storage object behind every attachment the contact has, claimed or not. */
  async objectIdsForContact(workspaceId: string, contactId: string): Promise<string[]> {
    const rows = await this.db
      .select({ objectId: a.objectId })
      .from(a)
      .where(and(eq(a.workspaceId, workspaceId), eq(a.contactId, contactId)));
    return rows.map(row => row.objectId);
  }

  async listForMessages(messageIds: readonly string[]): Promise<AttachmentRow[]> {
    if (messageIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(a)
      .where(inArray(a.messageId, [...messageIds]));
  }
}
