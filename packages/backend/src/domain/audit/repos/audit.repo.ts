import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';

import { AdvisoryLockNamespaces } from '@backend/infra/db/advisory-locks';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** The chain-linkage fields the repo computes (`prev_hash`/`hash`) plus the
 * `workspace_id` it is given — everything else about an entry comes from the caller. */
type AuditEntryFields = Omit<typeof schema.auditLog.$inferInsert, 'workspaceId' | 'prevHash' | 'hash'>;

/** Data access for mocco_audit_log — the append-only per-workspace hash chain (ADR
 * 0012). Every read/write is scoped by `workspace_id` (each workspace has its own
 * chain), so an entry is never resolved across the tenant boundary. */
export class AuditRepo {
  constructor(private readonly db: Db) {}

  /**
   * Append one entry, bound to the workspace's current chain head. Reading the head
   * and inserting the successor is ONE transaction guarded by a per-workspace
   * advisory lock, so two concurrent appends cannot both bind to the same
   * `prev_hash` — that would fork the chain, and `verify` would report the loser as
   * a tamper (a false "Chain broken" on the compliance surface). Concurrency here is
   * cross-instance: `client.ts` caps each serverless instance at one connection, so
   * the contention is between separate lambdas and only the DB can arbitrate it.
   *
   * The caller supplies `computeHash(prevHash)` rather than a finished hash, because
   * the hash depends on the predecessor that is only known once the lock is held.
   */
  async appendChained(workspaceId: string, entry: AuditEntryFields, computeHash: (prevHash: string | null) => string) {
    return await this.db.transaction(async tx => {
      // Serialize appends to THIS workspace's chain. `_xact_` releases on commit or
      // rollback (see advisory-locks.ts for why the session variant is unusable here).
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${AdvisoryLockNamespaces.auditChain}, hashtext(${workspaceId}))`,
      );
      const [head] = await tx
        .select({ hash: schema.auditLog.hash })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.workspaceId, workspaceId))
        .orderBy(desc(schema.auditLog.seq))
        .limit(1);
      const prevHash = head?.hash ?? null;
      return expectOne(
        await tx
          .insert(schema.auditLog)
          .values({ ...entry, workspaceId, prevHash, hash: computeHash(prevHash) })
          .returning(),
      );
    });
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
