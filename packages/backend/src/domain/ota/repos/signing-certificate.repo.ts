import { CertificateStatuses } from '@mocco/common/ota-hosting';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export type SigningCertificateRow = typeof schema.otaSigningCertificates.$inferSelect;

/** Data access for mocco_ota_signing_certificates. */
export class SigningCertificateRepo {
  constructor(private readonly db: Db) {}

  /** Insert a certificate. Throws UniqueConstraintError when the app already has this key. */
  async insert(row: typeof schema.otaSigningCertificates.$inferInsert) {
    try {
      return expectOne(await this.db.insert(schema.otaSigningCertificates).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async listByApp(workspaceId: string, appId: string) {
    return await this.db
      .select()
      .from(schema.otaSigningCertificates)
      .where(
        and(eq(schema.otaSigningCertificates.workspaceId, workspaceId), eq(schema.otaSigningCertificates.appId, appId)),
      )
      .orderBy(asc(schema.otaSigningCertificates.createdAt));
  }

  /** The app's active certificates for a keyid (several during a rotation). */
  async listActive(appId: string, keyid: string) {
    return await this.db
      .select()
      .from(schema.otaSigningCertificates)
      .where(
        and(
          eq(schema.otaSigningCertificates.appId, appId),
          eq(schema.otaSigningCertificates.keyid, keyid),
          eq(schema.otaSigningCertificates.status, CertificateStatuses.active),
        ),
      );
  }

  async getInApp(workspaceId: string, appId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.otaSigningCertificates)
      .where(
        and(
          eq(schema.otaSigningCertificates.id, id),
          eq(schema.otaSigningCertificates.workspaceId, workspaceId),
          eq(schema.otaSigningCertificates.appId, appId),
        ),
      );
    return getOrThrow(rows, `Signing certificate ${id} was not found`);
  }

  /** Per certificate and runtime version: how many of the app's updates it verified, and the latest. */
  async listUsage(appId: string) {
    return await this.db
      .select({
        certificateId: schema.otaUpdates.certificateId,
        runtimeVersion: schema.otaUpdates.runtimeVersion,
        updates: sql<number>`count(*)::int`,
        lastCommitTime: sql<Date>`max(${schema.otaUpdates.commitTime})`,
      })
      .from(schema.otaUpdates)
      .where(and(eq(schema.otaUpdates.appId, appId), isNotNull(schema.otaUpdates.certificateId)))
      .groupBy(schema.otaUpdates.certificateId, schema.otaUpdates.runtimeVersion);
  }

  async retire(id: string) {
    await this.db
      .update(schema.otaSigningCertificates)
      .set({ status: CertificateStatuses.retired })
      .where(eq(schema.otaSigningCertificates.id, id));
  }
}
