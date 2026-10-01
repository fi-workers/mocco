import { and, eq, isNull, lt } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type UploadSessionRow = typeof schema.otaUploadSessions.$inferSelect;

/** Data access for mocco_ota_upload_sessions. Sessions are found by token hash only. */
export class UploadSessionRepo {
  constructor(private readonly db: Db) {}

  async insert(row: typeof schema.otaUploadSessions.$inferInsert) {
    return expectOne(await this.db.insert(schema.otaUploadSessions).values(row).returning());
  }

  async findByTokenHash(tokenHash: string) {
    const [row] = await this.db
      .select()
      .from(schema.otaUploadSessions)
      .where(eq(schema.otaUploadSessions.tokenHash, tokenHash));
    return row;
  }

  /** Bind the session's one release; false when it already has one. */
  async attachRelease(id: string, releaseId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.otaUploadSessions)
      .set({ releaseId })
      .where(and(eq(schema.otaUploadSessions.id, id), isNull(schema.otaUploadSessions.releaseId)))
      .returning({ id: schema.otaUploadSessions.id });
    return rows.length > 0;
  }

  async deleteExpired(before: Date): Promise<number> {
    const rows = await this.db
      .delete(schema.otaUploadSessions)
      .where(lt(schema.otaUploadSessions.expiresAt, before))
      .returning({ id: schema.otaUploadSessions.id });
    return rows.length;
  }
}
