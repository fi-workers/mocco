import { and, eq, isNull, lte, notInArray, or, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { StaleKind } from '@mocco/common/flags';

export interface DesiredFinding {
  flagId: string;
  kind: StaleKind;
  lastEvaluatedAt: Date | null;
  servedVariant: string | null;
}

const f = schema.flagStaleFindings;

/** Data access for mocco_flag_stale_findings. Every query is scoped by workspace. */
export class FlagStaleFindingRepo {
  constructor(private readonly db: Db) {}

  /**
   * Make a project's findings exactly `desired`: new ones are inserted (detected now),
   * ones that still hold keep their detection time and dismissal, and the rest go.
   */
  async replaceForProject(
    workspaceId: string,
    projectId: string,
    desired: readonly DesiredFinding[],
    now: Date,
  ): Promise<void> {
    await this.db.transaction(async tx => {
      const keep = desired.map(finding => `${finding.flagId}:${finding.kind}`);
      await tx
        .delete(f)
        .where(
          and(
            eq(f.workspaceId, workspaceId),
            eq(f.projectId, projectId),
            ...(keep.length === 0 ? [] : [notInArray(sql<string>`${f.flagId}::text || ':' || ${f.kind}`, keep)]),
          ),
        );
      if (desired.length === 0) {
        return;
      }
      await tx
        .insert(f)
        .values(desired.map(finding => ({ ...finding, workspaceId, projectId, detectedAt: now })))
        .onConflictDoUpdate({
          target: [f.flagId, f.kind],
          set: {
            lastEvaluatedAt: sql`excluded.last_evaluated_at`,
            servedVariant: sql`excluded.served_variant`,
          },
        });
    });
  }

  /** A project's findings with their flag's key; `activeAt` hides the dismissed ones. */
  async listByProject(workspaceId: string, projectId: string, activeAt?: Date) {
    return await this.db
      .select({
        id: f.id,
        flagId: f.flagId,
        flagKey: schema.flags.key,
        kind: f.kind,
        detectedAt: f.detectedAt,
        lastEvaluatedAt: f.lastEvaluatedAt,
        servedVariant: f.servedVariant,
        dismissedUntil: f.dismissedUntil,
      })
      .from(f)
      .innerJoin(schema.flags, and(eq(schema.flags.id, f.flagId), eq(schema.flags.workspaceId, f.workspaceId)))
      .where(
        and(
          eq(f.workspaceId, workspaceId),
          eq(f.projectId, projectId),
          ...(activeAt === undefined ? [] : [or(isNull(f.dismissedUntil), lte(f.dismissedUntil, activeAt))]),
        ),
      )
      .orderBy(schema.flags.key, f.kind);
  }

  /** Hide a finding until `until` (null shows it again). Returns the row, if it exists. */
  async dismiss(workspaceId: string, projectId: string, findingId: string, until: Date | null, userId: string) {
    const [row] = await this.db
      .update(f)
      .set({ dismissedUntil: until, dismissedByUserId: until === null ? null : userId })
      .where(and(eq(f.id, findingId), eq(f.workspaceId, workspaceId), eq(f.projectId, projectId)))
      .returning();
    return row;
  }

  /** Every project that has at least one flag. */
  async projectsWithFlags(): Promise<{ workspaceId: string; projectId: string }[]> {
    return await this.db
      .selectDistinct({ workspaceId: schema.flags.workspaceId, projectId: schema.flags.projectId })
      .from(schema.flags);
  }
}
