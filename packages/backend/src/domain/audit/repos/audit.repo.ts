import { and, asc, desc, eq, gt } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_audit_log — the append-only per-workspace hash chain (ADR
 * 0012). Every read/write is scoped by `workspace_id` (each workspace has its own
 * chain), so an entry is never resolved across the tenant boundary. */
export class AuditRepo {
  constructor(private readonly db: Db) {}

  /** The hash of the workspace's highest-`seq` entry (the chain head), or null when
   * the chain is empty — the `prev_hash` the next append binds to. */
  async lastHash(workspaceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ hash: schema.auditLog.hash })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.workspaceId, workspaceId))
      .orderBy(desc(schema.auditLog.seq))
      .limit(1);
    return row?.hash ?? null;
  }

  /** Append one entry and return the created row (with its assigned `seq`). */
  async append(row: typeof schema.auditLog.$inferInsert) {
    return expectOne(await this.db.insert(schema.auditLog).values(row).returning());
  }

  /** A workspace's entries with `seq > sinceSeq`, oldest-first — the read surface's
   * `sinceSeq` cursor (PR2's silent poll). */
  async listByWorkspace(workspaceId: string, sinceSeq: bigint) {
    return await this.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.workspaceId, workspaceId), gt(schema.auditLog.seq, sinceSeq)))
      .orderBy(asc(schema.auditLog.seq));
  }

  /** Every entry in the workspace's chain, oldest-first — the input `verify` re-walks. */
  async all(workspaceId: string) {
    return await this.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.workspaceId, workspaceId))
      .orderBy(asc(schema.auditLog.seq));
  }
}
