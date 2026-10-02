import { OtaReleaseStatuses, OtaUpdateKinds } from '@mocco/common/ota-hosting';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { OtaPlatform, OtaReleaseStatus } from '@mocco/common/ota-hosting';

export type OtaReleaseRow = typeof schema.otaReleases.$inferSelect;
export type OtaUpdateRow = typeof schema.otaUpdates.$inferSelect;

/** A release with its platforms and the largest platform's download (for lists). */
export interface OtaReleaseSummary extends OtaReleaseRow {
  platforms: OtaPlatform[];
  downloadBytes: number;
}

/** What finalize stores, all in one transaction. */
export interface FinalizedContent {
  updates: (typeof schema.otaUpdates.$inferInsert)[];
  updateAssets: (typeof schema.otaUpdateAssets.$inferInsert)[];
  directives: (typeof schema.otaSignedDirectives.$inferInsert)[];
}

/** Data access for mocco_ota_releases and the updates and directives that belong to them. */
export class OtaReleaseRepo {
  constructor(private readonly db: Db) {}

  private async storeFinalizedOnce(releaseId: string, content: FinalizedContent): Promise<boolean> {
    return await this.db.transaction(async tx => {
      const moved = await tx
        .update(schema.otaReleases)
        .set({ status: OtaReleaseStatuses.verifying })
        .where(and(eq(schema.otaReleases.id, releaseId), eq(schema.otaReleases.status, OtaReleaseStatuses.uploading)))
        .returning({ id: schema.otaReleases.id });
      if (moved.length === 0) {
        return false;
      }
      await tx.insert(schema.otaUpdates).values(content.updates);
      if (content.updateAssets.length > 0) {
        await tx.insert(schema.otaUpdateAssets).values(content.updateAssets);
      }
      if (content.directives.length > 0) {
        await tx.insert(schema.otaSignedDirectives).values(content.directives);
      }
      return true;
    });
  }

  async insert(row: typeof schema.otaReleases.$inferInsert) {
    return expectOne(await this.db.insert(schema.otaReleases).values(row).returning());
  }

  async getInApp(appId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.otaReleases)
      .where(and(eq(schema.otaReleases.id, id), eq(schema.otaReleases.appId, appId)));
    return getOrThrow(rows, `OTA release ${id} was not found`);
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(schema.otaReleases).where(eq(schema.otaReleases.id, id));
    return row;
  }

  /** Move a release between statuses; false when it isn't in one of `from` any more. */
  async setStatus(id: string, from: readonly OtaReleaseStatus[], to: OtaReleaseStatus): Promise<boolean> {
    const rows = await this.db
      .update(schema.otaReleases)
      .set({ status: to })
      .where(and(eq(schema.otaReleases.id, id), inArray(schema.otaReleases.status, [...from])))
      .returning({ id: schema.otaReleases.id });
    return rows.length > 0;
  }

  /**
   * Store a finalized release's updates, their asset links and its directives, and move
   * it from `uploading` to `verifying`, atomically. False (nothing stored) when the
   * release was no longer `uploading` — finalized concurrently. Throws UniqueConstraintError
   * when an update id was used before.
   */
  async storeFinalized(releaseId: string, content: FinalizedContent): Promise<boolean> {
    try {
      return await this.storeFinalizedOnce(releaseId, content);
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  /** Fail releases still `uploading` since before `before` (their session expired unfinalized). */
  async failStaleUploading(before: Date): Promise<number> {
    const rows = await this.db
      .update(schema.otaReleases)
      .set({ status: OtaReleaseStatuses.failed })
      .where(and(eq(schema.otaReleases.status, OtaReleaseStatuses.uploading), lt(schema.otaReleases.createdAt, before)))
      .returning({ id: schema.otaReleases.id });
    return rows.length;
  }

  async findUpdate(id: string) {
    const [row] = await this.db.select().from(schema.otaUpdates).where(eq(schema.otaUpdates.id, id));
    return row;
  }

  /** The asset hashes an update references (launch asset included). */
  async assetHashesOf(updateId: string): Promise<string[]> {
    const rows = await this.db
      .select({ hash: schema.otaUpdateAssets.assetHash })
      .from(schema.otaUpdateAssets)
      .where(eq(schema.otaUpdateAssets.updateId, updateId));
    return rows.map(row => row.hash);
  }

  /** The app's releases, newest first, with platforms and download size from their original updates. */
  async listByApp(workspaceId: string, appId: string, limit = 50): Promise<OtaReleaseSummary[]> {
    const rows = await this.db
      .select({
        release: schema.otaReleases,
        platforms: sql<
          OtaPlatform[] | null
        >`array_agg(${schema.otaUpdates.platform} ORDER BY ${schema.otaUpdates.platform}) FILTER (WHERE ${schema.otaUpdates.id} IS NOT NULL)`,
        downloadBytes: sql<string | null>`max(${schema.otaUpdates.totalBytes})`,
      })
      .from(schema.otaReleases)
      .leftJoin(
        schema.otaUpdates,
        and(
          eq(schema.otaUpdates.releaseId, schema.otaReleases.id),
          eq(schema.otaUpdates.kind, OtaUpdateKinds.original),
        ),
      )
      .where(and(eq(schema.otaReleases.workspaceId, workspaceId), eq(schema.otaReleases.appId, appId)))
      .groupBy(schema.otaReleases.id)
      .orderBy(desc(schema.otaReleases.createdAt))
      .limit(limit);
    return rows.map(row => ({
      ...row.release,
      platforms: row.platforms ?? [],
      downloadBytes: Number(row.downloadBytes ?? 0),
    }));
  }

  /** What each channel head of the app serves now for these platforms and runtime: the
   * targets a new release pre-signs rollbacks to. */
  async listActiveHeads(appId: string, runtimeVersion: string, platforms: readonly OtaPlatform[]) {
    return await this.db
      .select({
        channel: schema.otaChannels.name,
        platform: schema.otaChannelHeads.platform,
        updateId: schema.otaUpdates.id,
        manifest: schema.otaUpdates.manifestBody,
      })
      .from(schema.otaChannelHeads)
      .innerJoin(schema.otaChannels, eq(schema.otaChannels.id, schema.otaChannelHeads.channelId))
      .innerJoin(schema.otaUpdates, eq(schema.otaUpdates.id, schema.otaChannelHeads.activeUpdateId))
      .where(
        and(
          eq(schema.otaChannels.appId, appId),
          eq(schema.otaChannelHeads.runtimeVersion, runtimeVersion),
          inArray(schema.otaChannelHeads.platform, [...platforms]),
        ),
      );
  }
}
