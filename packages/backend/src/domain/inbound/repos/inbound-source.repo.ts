import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const { inboundSources } = schema;

export type InboundSourceRow = typeof inboundSources.$inferSelect;
export type NewInboundSource = Pick<
  typeof inboundSources.$inferInsert,
  'id' | 'workspaceId' | 'kind' | 'name' | 'ingestKey' | 'secretSealed'
>;
export type InboundSourcePatch = Partial<Pick<InboundSourceRow, 'name' | 'status' | 'secretSealed'>>;

/** Data access for mocco_inbound_sources (ADR 0012). Reads and writes by id are scoped
 * by `workspace_id`; the platform-scoped reads are `findByIngestKey`, since the key is
 * how a delivery finds its tenant, and `findById`, for the operator-configured stage0
 * canary source (`OPS_CANARY_SOURCE_ID`). */
export class InboundSourceRepo {
  constructor(private readonly db: Db) {}

  async create(values: NewInboundSource): Promise<InboundSourceRow> {
    return expectOne(await this.db.insert(inboundSources).values(values).returning());
  }

  /** A workspace's sources, oldest first. */
  async listByWorkspace(workspaceId: string): Promise<InboundSourceRow[]> {
    return await this.db
      .select()
      .from(inboundSources)
      .where(eq(inboundSources.workspaceId, workspaceId))
      .orderBy(asc(inboundSources.createdAt), asc(inboundSources.id));
  }

  /** A source of the workspace, or throw EntityNotFoundError for a foreign or unknown id. */
  async getByIdInWorkspace(workspaceId: string, sourceId: string): Promise<InboundSourceRow> {
    const rows = await this.db
      .select()
      .from(inboundSources)
      .where(and(eq(inboundSources.id, sourceId), eq(inboundSources.workspaceId, workspaceId)));
    return getOrThrow(rows, `Inbound source ${sourceId} was not found`);
  }

  /** The source with this id in any workspace, or undefined (the stage0 canary's source,
   * which the operator names by id). */
  async findById(sourceId: string): Promise<InboundSourceRow | undefined> {
    const [row] = await this.db.select().from(inboundSources).where(eq(inboundSources.id, sourceId));
    return row;
  }

  /** The source a delivery URL names, or undefined. */
  async findByIngestKey(ingestKey: string): Promise<InboundSourceRow | undefined> {
    const [row] = await this.db.select().from(inboundSources).where(eq(inboundSources.ingestKey, ingestKey));
    return row;
  }

  /** Update a source of the workspace; throws EntityNotFoundError for a foreign or unknown id. */
  async update(workspaceId: string, sourceId: string, patch: InboundSourcePatch): Promise<InboundSourceRow> {
    const rows = await this.db
      .update(inboundSources)
      .set(patch)
      .where(and(eq(inboundSources.id, sourceId), eq(inboundSources.workspaceId, workspaceId)))
      .returning();
    return getOrThrow(rows, `Inbound source ${sourceId} was not found`);
  }

  /** Delete a source of the workspace (its receipts cascade). False when there was none. */
  async delete(workspaceId: string, sourceId: string): Promise<boolean> {
    const rows = await this.db
      .delete(inboundSources)
      .where(and(eq(inboundSources.id, sourceId), eq(inboundSources.workspaceId, workspaceId)))
      .returning({ id: inboundSources.id });
    return rows.length > 0;
  }

  /**
   * Record that the source received a verified delivery, at most once per `throttleMs`
   * (a busy source would otherwise rewrite its row on every delivery). `updated_at` is
   * left alone: it tracks configuration changes, not traffic.
   */
  async touchLastReceived(sourceId: string, at: Date, throttleMs: number): Promise<void> {
    const threshold = new Date(at.getTime() - throttleMs);
    await this.db
      .update(inboundSources)
      .set({ lastReceivedAt: at, updatedAt: sql`${inboundSources.updatedAt}` })
      .where(
        and(
          eq(inboundSources.id, sourceId),
          or(isNull(inboundSources.lastReceivedAt), lt(inboundSources.lastReceivedAt, threshold)),
        ),
      );
  }
}
