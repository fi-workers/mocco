import { AuditActions } from '@mocco/common/audit';
import { OtaDeploymentKinds, OtaReleaseStatuses } from '@mocco/common/ota-hosting';

import {
  OtaAppNotFoundError,
  OtaChannelNotFoundError,
  OtaChannelProtectedError,
  OtaReleaseNotFoundError,
  OtaReleaseNotReadyError,
  OtaReleaseOlderThanHeadError,
} from '@backend/domain/ota/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { ApiPrincipal } from '@backend/domain/apikey/ApiKeyService';
import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ChannelHeadRepo } from '@backend/domain/ota/repos/channel-head.repo';
import type { OtaAppRepo, OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { OtaChannelRepo, OtaChannelRow } from '@backend/domain/ota/repos/ota-channel.repo';
import type { OtaReleaseRepo, OtaReleaseRow } from '@backend/domain/ota/repos/ota-release.repo';
import type { ChannelStateCache } from '@backend/domain/ota/serving/state-cache';
import type { OtaChannelHeadDto, PromotionResult } from '@mocco/common/ota-hosting';

export interface ChannelServiceDeps {
  apps: OtaAppRepo;
  channels: OtaChannelRepo;
  releases: OtaReleaseRepo;
  heads: ChannelHeadRepo;
  audit: AuditService;
  cache: ChannelStateCache;
  now?: () => Date;
}

/** Who changes a channel: a console user or a machine principal (an API key, CI). */
export interface ChannelActor {
  userId: string | null;
  principal: string | null;
}

/**
 * What each channel serves (OTA design §5). Promotion points a channel's heads at a
 * `ready` release's updates. Protected channels change only through an approved request
 * (invariant 6), which lands with gated promotion; here they are refused.
 */
export class OtaChannelService {
  private readonly now: () => Date;

  constructor(private readonly deps: ChannelServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async requireRelease(app: OtaAppRow, releaseId: string): Promise<OtaReleaseRow> {
    try {
      return await this.deps.releases.getInApp(app.id, releaseId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new OtaReleaseNotFoundError(releaseId, { cause: error });
      }
      throw error;
    }
  }

  private async promoteTo(
    app: OtaAppRow,
    channel: OtaChannelRow,
    releaseId: string,
    actor: ChannelActor,
    reason: string | null,
  ): Promise<PromotionResult> {
    if (channel.isProtected) {
      throw new OtaChannelProtectedError(channel.name);
    }
    const release = await this.requireRelease(app, releaseId);
    if (release.status !== OtaReleaseStatuses.ready) {
      throw new OtaReleaseNotReadyError(release.id, release.status);
    }
    const updates = await this.deps.releases.listOriginalUpdates(release.id);
    const platforms = updates.map(update => update.platform);
    const heads = await this.deps.heads.listForChannel(channel.id, release.runtimeVersion, platforms);
    const older = updates.find(update => {
      const head = heads.find(candidate => candidate.platform === update.platform);
      return (
        head?.activeCommitTime !== null &&
        head?.activeCommitTime !== undefined &&
        head.activeUpdateId !== update.id &&
        head.activeCommitTime >= update.commitTime
      );
    });
    if (older !== undefined) {
      throw new OtaReleaseOlderThanHeadError(channel.name, older.platform);
    }
    const isUnchanged = updates.every(update =>
      heads.some(head => head.platform === update.platform && head.activeUpdateId === update.id),
    );
    if (isUnchanged) {
      return { channel: channel.name, releaseId: release.id, platforms, changed: false };
    }
    await this.deps.heads.promote({
      workspaceId: app.workspaceId,
      channelId: channel.id,
      releaseId: release.id,
      runtimeVersion: release.runtimeVersion,
      updates: updates.map(update => ({ platform: update.platform, updateId: update.id })),
      actorUserId: actor.userId,
      actorPrincipal: actor.principal,
      approvalRequestId: null,
      reason,
      now: this.now(),
    });
    this.deps.cache.invalidateChannel(app.id, channel.name);
    await this.deps.audit.record(app.workspaceId, {
      actorUserId: actor.userId,
      action: AuditActions.otaChannelChanged,
      subjectType: 'ota_channel',
      subjectId: channel.id,
      payload: {
        kind: OtaDeploymentKinds.promote,
        channel: channel.name,
        releaseId: release.id,
        runtimeVersion: release.runtimeVersion,
        platforms,
        principal: actor.principal,
        approvalRequestId: null,
        reason,
      },
    });
    return { channel: channel.name, releaseId: release.id, platforms, changed: true };
  }

  /** Promote from the console. */
  async promote(
    app: OtaAppRow,
    channelId: string,
    releaseId: string,
    actorUserId: string,
    reason: string | null,
  ): Promise<PromotionResult> {
    let channel: OtaChannelRow;
    try {
      channel = await this.deps.channels.getInApp(app.workspaceId, app.id, channelId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new OtaChannelNotFoundError(channelId, { cause: error });
      }
      throw error;
    }
    return await this.promoteTo(app, channel, releaseId, { userId: actorUserId, principal: null }, reason);
  }

  /** Promote from CI with a secret API key whose project owns the app. */
  async promoteAsKey(
    principal: ApiPrincipal,
    appId: string,
    releaseId: string,
    channelName: string,
    reason: string | null,
  ): Promise<PromotionResult> {
    const app = await this.requireKeyApp(principal, appId);
    const channel = await this.deps.channels.findByName(app.id, channelName);
    if (channel === undefined) {
      throw new OtaChannelNotFoundError(channelName);
    }
    return await this.promoteTo(
      app,
      channel,
      releaseId,
      { userId: null, principal: `apikey:${principal.keyId}` },
      reason,
    );
  }

  /** The app of a key's project, or OtaAppNotFoundError (other projects' apps look missing). */
  async requireKeyApp(principal: ApiPrincipal, appId: string): Promise<OtaAppRow> {
    const app = await this.deps.apps.findById(appId);
    if (app?.workspaceId !== principal.workspaceId || app.projectId !== principal.projectId) {
      throw new OtaAppNotFoundError(appId);
    }
    return app;
  }

  /** A release's status, for CI waiting on `ready`. */
  async releaseStatusAsKey(principal: ApiPrincipal, appId: string, releaseId: string) {
    const app = await this.requireKeyApp(principal, appId);
    const release = await this.requireRelease(app, releaseId);
    return { id: release.id, status: release.status, runtimeVersion: release.runtimeVersion };
  }

  /** What every channel head of the app serves now. */
  async listHeads(app: OtaAppRow): Promise<OtaChannelHeadDto[]> {
    const rows = await this.deps.heads.listByApp(app.workspaceId, app.id);
    return rows.map(row => ({
      channelId: row.channelId,
      platform: row.platform,
      runtimeVersion: row.runtimeVersion,
      releaseId: row.activeReleaseId,
      updatedAt: row.updatedAt,
    }));
  }
}
