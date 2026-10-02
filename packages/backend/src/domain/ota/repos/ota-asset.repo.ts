import { and, eq, inArray, isNull } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type OtaAssetRow = typeof schema.otaAssets.$inferSelect;

/** An asset with the state of the object holding its bytes. */
export interface OtaAssetWithObject {
  asset: OtaAssetRow;
  object: typeof schema.objects.$inferSelect | null;
}

/** Data access for mocco_ota_assets: content-addressed per app, deduplicated across releases. */
export class OtaAssetRepo {
  constructor(private readonly db: Db) {}

  /** The app's assets among `hashes`, each with its object (null when none). */
  async listWithObjects(appId: string, hashes: readonly string[]): Promise<OtaAssetWithObject[]> {
    if (hashes.length === 0) {
      return [];
    }
    return await this.db
      .select({ asset: schema.otaAssets, object: schema.objects })
      .from(schema.otaAssets)
      .leftJoin(schema.objects, eq(schema.objects.id, schema.otaAssets.objectId))
      .where(and(eq(schema.otaAssets.appId, appId), inArray(schema.otaAssets.hash, [...hashes])));
  }

  /** Record the asset (or point an existing one at a fresh upload) — unverified either way. */
  async upsertPending(row: typeof schema.otaAssets.$inferInsert & { objectId: string }) {
    await this.db
      .insert(schema.otaAssets)
      .values(row)
      .onConflictDoUpdate({
        target: [schema.otaAssets.appId, schema.otaAssets.hash],
        set: {
          objectId: row.objectId,
          contentType: row.contentType,
          fileExtension: row.fileExtension,
          sizeBytes: row.sizeBytes,
          verifiedAt: null,
        },
      });
  }

  async markVerified(appId: string, hash: string, at: Date) {
    await this.db
      .update(schema.otaAssets)
      .set({ verifiedAt: at })
      .where(and(eq(schema.otaAssets.appId, appId), eq(schema.otaAssets.hash, hash)));
  }

  /** Forget the bytes of an asset that failed verification, so a re-upload replaces them. */
  async clearObject(appId: string, hash: string) {
    await this.db
      .update(schema.otaAssets)
      .set({ objectId: null, verifiedAt: null })
      .where(and(eq(schema.otaAssets.appId, appId), eq(schema.otaAssets.hash, hash)));
  }

  /** The distinct assets a release's updates reference that are not verified yet. */
  async listUnverifiedForRelease(releaseId: string): Promise<OtaAssetWithObject[]> {
    return await this.db
      .selectDistinctOn([schema.otaAssets.hash], { asset: schema.otaAssets, object: schema.objects })
      .from(schema.otaUpdates)
      .innerJoin(schema.otaUpdateAssets, eq(schema.otaUpdateAssets.updateId, schema.otaUpdates.id))
      .innerJoin(
        schema.otaAssets,
        and(
          eq(schema.otaAssets.appId, schema.otaUpdateAssets.appId),
          eq(schema.otaAssets.hash, schema.otaUpdateAssets.assetHash),
        ),
      )
      .leftJoin(schema.objects, eq(schema.objects.id, schema.otaAssets.objectId))
      .where(and(eq(schema.otaUpdates.releaseId, releaseId), isNull(schema.otaAssets.verifiedAt)));
  }
}
