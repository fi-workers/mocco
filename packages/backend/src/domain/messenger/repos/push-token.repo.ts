import { and, eq, inArray, isNull } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type PushTokenRow = typeof schema.messengerPushTokens.$inferSelect;

const p = schema.messengerPushTokens;

/** Data access for mocco_messenger_push_tokens. */
export class MessengerPushTokenRepo {
  constructor(private readonly db: Db) {}

  /** Register a device for a contact; a token already in the project moves to this contact. */
  async upsert(row: typeof p.$inferInsert): Promise<void> {
    await this.db
      .insert(p)
      .values(row)
      .onConflictDoUpdate({
        target: [p.projectId, p.token],
        set: { contactId: row.contactId, platform: row.platform, lastSeenAt: row.lastSeenAt, disabledAt: null },
      });
  }

  async remove(projectId: string, contactId: string, token: string): Promise<void> {
    await this.db.delete(p).where(and(eq(p.projectId, projectId), eq(p.contactId, contactId), eq(p.token, token)));
  }

  async activeForContact(contactId: string): Promise<PushTokenRow[]> {
    return await this.db
      .select()
      .from(p)
      .where(and(eq(p.contactId, contactId), isNull(p.disabledAt)));
  }

  async disable(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length > 0) {
      await this.db
        .update(p)
        .set({ disabledAt: now })
        .where(inArray(p.id, [...ids]));
    }
  }
}
