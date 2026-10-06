import { and, eq, inArray, isNull } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type AttachmentRow = typeof schema.messengerAttachments.$inferSelect;

const a = schema.messengerAttachments;
const o = schema.objects;

/** Data access for mocco_messenger_attachments. Scoped by workspace and contact. */
export class MessengerAttachmentRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof a.$inferInsert): Promise<AttachmentRow> {
    return expectOne(await this.db.insert(a).values(row).returning());
  }

  /**
   * The attachments among `ids` reserved for the contact that no message has claimed
   * yet, and uploaded by `uploadedBy`: a team member's id (their uploads, from the
   * inbox, are kept on the storage object's `created_by_user_id`), or null for the
   * contact's own. So neither side can send what the other reserved.
   */
  async findUnclaimed(
    workspaceId: string,
    contactId: string,
    ids: readonly string[],
    uploadedBy: string | null,
  ): Promise<AttachmentRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .select({ attachment: a })
      .from(a)
      .innerJoin(o, and(eq(o.id, a.objectId), eq(o.workspaceId, a.workspaceId)))
      .where(
        and(
          eq(a.workspaceId, workspaceId),
          eq(a.contactId, contactId),
          inArray(a.id, [...ids]),
          isNull(a.messageId),
          uploadedBy === null ? isNull(o.createdByUserId) : eq(o.createdByUserId, uploadedBy),
        ),
      );
    return rows.map(row => row.attachment);
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
