import { randomBytes } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import * as schema from '@backend/infra/db/schema';

import type { HeadState } from '@backend/domain/ota/serving/select';
import type { Db } from '@backend/infra/db/types';
import type { OtaDeploymentKind, OtaPlatform } from '@mocco/common/ota-hosting';

export type ChannelHeadRow = typeof schema.otaChannelHeads.$inferSelect;

const active = alias(schema.otaUpdates, 'active');
const candidate = alias(schema.otaUpdates, 'candidate');

/** One head an app's channel serves, with the release behind its active update. */
export interface ChannelHeadSummary {
  channelId: string;
  platform: OtaPlatform;
  runtimeVersion: string;
  activeUpdateId: string | null;
  activeReleaseId: string | null;
  activeCommitTime: Date | null;
  version: number;
  updatedAt: Date;
}

/** A head with what its active and candidate updates are (release, commit time, content). */
export interface ChannelHeadDetail {
  head: ChannelHeadRow;
  active: { id: string; releaseId: string; commitTime: Date; contentOfUpdateId: string } | null;
  candidate: { id: string; releaseId: string; commitTime: Date; contentOfUpdateId: string } | null;
}

/** The fields one head change sets (left out = unchanged). */
export type HeadWrite = Pick<ChannelHeadRow, 'platform' | 'runtimeVersion'> &
  Partial<
    Pick<
      ChannelHeadRow,
      'activeUpdateId' | 'candidateUpdateId' | 'previousUpdateId' | 'rolloutBp' | 'isPaused' | 'serveDirectiveId'
    >
  >;

/** Data access for mocco_ota_channel_heads — the serving state — and the deployment history. */
export class ChannelHeadRepo {
  constructor(private readonly db: Db) {}

  /** The serving state for a device's (app, channel, platform, runtime), or undefined. One query. */
  async findServingState(
    appId: string,
    channel: string,
    platform: OtaPlatform,
    runtimeVersion: string,
  ): Promise<HeadState | undefined> {
    const [row] = await this.db
      .select({
        head: schema.otaChannelHeads,
        active: { id: active.id, body: active.manifestBody, signature: active.signature, keyid: active.keyid },
        candidate: {
          id: candidate.id,
          body: candidate.manifestBody,
          signature: candidate.signature,
          keyid: candidate.keyid,
        },
        directive: {
          id: schema.otaSignedDirectives.id,
          body: schema.otaSignedDirectives.body,
          signature: schema.otaSignedDirectives.signature,
          keyid: schema.otaSignedDirectives.keyid,
        },
      })
      .from(schema.otaChannelHeads)
      .innerJoin(schema.otaChannels, eq(schema.otaChannels.id, schema.otaChannelHeads.channelId))
      .leftJoin(active, eq(active.id, schema.otaChannelHeads.activeUpdateId))
      .leftJoin(candidate, eq(candidate.id, schema.otaChannelHeads.candidateUpdateId))
      .leftJoin(schema.otaSignedDirectives, eq(schema.otaSignedDirectives.id, schema.otaChannelHeads.serveDirectiveId))
      .where(
        and(
          eq(schema.otaChannels.appId, appId),
          eq(schema.otaChannels.name, channel),
          eq(schema.otaChannelHeads.platform, platform),
          eq(schema.otaChannelHeads.runtimeVersion, runtimeVersion),
        ),
      );
    if (row === undefined) {
      return undefined;
    }
    // Each left-joined part comes back as the whole object or null.
    return {
      active: row.active,
      candidate: row.candidate,
      rolloutBp: row.head.rolloutBp,
      rolloutSalt: row.head.rolloutSalt,
      isPaused: row.head.isPaused,
      directive: row.directive,
    };
  }

  /** Every head of the app's channels, with the release each one serves. */
  async listByApp(workspaceId: string, appId: string): Promise<ChannelHeadSummary[]> {
    return await this.db
      .select({
        channelId: schema.otaChannelHeads.channelId,
        platform: schema.otaChannelHeads.platform,
        runtimeVersion: schema.otaChannelHeads.runtimeVersion,
        activeUpdateId: schema.otaChannelHeads.activeUpdateId,
        activeReleaseId: active.releaseId,
        activeCommitTime: active.commitTime,
        version: schema.otaChannelHeads.version,
        updatedAt: schema.otaChannelHeads.updatedAt,
      })
      .from(schema.otaChannelHeads)
      .innerJoin(schema.otaChannels, eq(schema.otaChannels.id, schema.otaChannelHeads.channelId))
      .leftJoin(active, eq(active.id, schema.otaChannelHeads.activeUpdateId))
      .where(and(eq(schema.otaChannelHeads.workspaceId, workspaceId), eq(schema.otaChannels.appId, appId)))
      .orderBy(schema.otaChannelHeads.runtimeVersion, schema.otaChannelHeads.platform);
  }

  /** The heads of one channel for these platforms and runtime, with their active commit time. */
  async listForChannel(channelId: string, runtimeVersion: string, platforms: readonly OtaPlatform[]) {
    return await this.db
      .select({
        platform: schema.otaChannelHeads.platform,
        activeUpdateId: schema.otaChannelHeads.activeUpdateId,
        activeCommitTime: active.commitTime,
      })
      .from(schema.otaChannelHeads)
      .leftJoin(active, eq(active.id, schema.otaChannelHeads.activeUpdateId))
      .where(
        and(
          eq(schema.otaChannelHeads.channelId, channelId),
          eq(schema.otaChannelHeads.runtimeVersion, runtimeVersion),
          inArray(schema.otaChannelHeads.platform, [...platforms]),
        ),
      );
  }

  /** Every head of one channel, with what its active and candidate updates are. */
  async listHeadsOfChannel(channelId: string): Promise<ChannelHeadDetail[]> {
    return await this.db
      .select({
        head: schema.otaChannelHeads,
        active: {
          id: active.id,
          releaseId: active.releaseId,
          commitTime: active.commitTime,
          contentOfUpdateId: active.contentOfUpdateId,
        },
        candidate: {
          id: candidate.id,
          releaseId: candidate.releaseId,
          commitTime: candidate.commitTime,
          contentOfUpdateId: candidate.contentOfUpdateId,
        },
      })
      .from(schema.otaChannelHeads)
      .leftJoin(active, eq(active.id, schema.otaChannelHeads.activeUpdateId))
      .leftJoin(candidate, eq(candidate.id, schema.otaChannelHeads.candidateUpdateId))
      .where(eq(schema.otaChannelHeads.channelId, channelId))
      .orderBy(schema.otaChannelHeads.runtimeVersion, schema.otaChannelHeads.platform);
  }

  /**
   * Change heads and append the deployment that explains it, in one transaction: the only
   * write path for serving state. A head is created on first use (with a fresh rollout
   * salt); each change bumps its version, the serving cache key.
   */
  async writeHeads(input: {
    workspaceId: string;
    channelId: string;
    writes: readonly HeadWrite[];
    deployment: {
      releaseId: string | null;
      kind: OtaDeploymentKind;
      fromBp: number | null;
      toBp: number | null;
      actorUserId: string | null;
      actorPrincipal: string | null;
      approvalRequestId: string | null;
      reason: string | null;
    };
    now: Date;
  }): Promise<void> {
    await this.db.transaction(async tx => {
      await Promise.all(
        input.writes.map(async ({ platform, runtimeVersion, ...set }) => {
          // Plans set only the fields they change; the rest keep their values.
          const changes = set;
          await tx
            .insert(schema.otaChannelHeads)
            .values({
              workspaceId: input.workspaceId,
              channelId: input.channelId,
              platform,
              runtimeVersion,
              rolloutSalt: randomBytes(8).toString('hex'),
              updatedAt: input.now,
              ...changes,
            })
            .onConflictDoUpdate({
              target: [
                schema.otaChannelHeads.channelId,
                schema.otaChannelHeads.platform,
                schema.otaChannelHeads.runtimeVersion,
              ],
              set: { ...changes, version: sql`${schema.otaChannelHeads.version} + 1`, updatedAt: input.now },
            });
        }),
      );
      await tx.insert(schema.otaDeployments).values({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        ...input.deployment,
        createdAt: input.now,
      });
    });
  }

  /** A channel's deployment history, newest first. */
  async listDeployments(channelId: string, limit = 20) {
    return await this.db
      .select()
      .from(schema.otaDeployments)
      .where(eq(schema.otaDeployments.channelId, channelId))
      .orderBy(desc(schema.otaDeployments.createdAt))
      .limit(limit);
  }
}
