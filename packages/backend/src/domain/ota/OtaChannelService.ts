import { AuditActions } from '@mocco/common/audit';
import { OtaEventTypes } from '@mocco/common/events';
import { ApprovalDecisions, ApprovalKinds, gateRequirementsSchema } from '@mocco/common/governance';
import { OtaDeploymentKinds, OtaHostingApprovalSubjects, OtaReleaseStatuses } from '@mocco/common/ota-hosting';
import { z } from 'zod';

import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';
import { publishBestEffort } from '@backend/domain/events/ports';
import {
  OtaAppNotFoundError,
  OtaChannelNotAllowedError,
  OtaChannelNotFoundError,
  OtaChannelProtectedError,
  OtaReleaseNotFoundError,
  OtaReleaseNotReadyError,
  OtaReleaseOlderThanHeadError,
} from '@backend/domain/ota/errors';
import { promotionMessage } from '@backend/domain/ota/promotion-message';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { ApiPrincipal } from '@backend/domain/apikey/ApiKeyService';
import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { ApprovalRequestRow, ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { ChannelHeadRepo } from '@backend/domain/ota/repos/channel-head.repo';
import type { OtaAppRepo, OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { OtaAssetRepo } from '@backend/domain/ota/repos/ota-asset.repo';
import type { OtaChannelRepo, OtaChannelRow } from '@backend/domain/ota/repos/ota-channel.repo';
import type { OtaReleaseRepo, OtaReleaseRow } from '@backend/domain/ota/repos/ota-release.repo';
import type { UploadSessionRow } from '@backend/domain/ota/repos/upload-session.repo';
import type { ChannelStateCache } from '@backend/domain/ota/serving/state-cache';
import type { OtaChannelHeadDto, PromotionPreview, PromotionResult } from '@mocco/common/ota-hosting';

export interface ChannelServiceDeps {
  apps: OtaAppRepo;
  channels: OtaChannelRepo;
  releases: OtaReleaseRepo;
  heads: ChannelHeadRepo;
  assets: OtaAssetRepo;
  approvals: ApprovalService;
  audit: AuditService;
  cache: ChannelStateCache;
  /** Where promotion requests and decisions are published (notifications). */
  events?: EventPublisher;
  /** The app origin, for links in notification messages. */
  appOrigin?: string;
  now?: () => Date;
}

/** Who changes a channel: a console user or a machine principal (an API key, CI). */
export interface ChannelActor {
  userId: string | null;
  principal: string | null;
  /** The person a machine principal acts for (a key's creator, a run's trigger): the
   * requester for prevent_self, so CI can't be used to approve your own change. */
  actingUserId: string | null;
}

/** The pinned action of an `ota.channel_change` request — exactly what the handler applies. */
const pinnedChangeSchema = z.object({
  kind: z.literal(OtaDeploymentKinds.promote),
  channelId: z.uuid(),
  releaseId: z.uuid(),
  reason: z.string().nullable(),
  principal: z.string().nullable(),
});

interface CheckedPromotion {
  release: OtaReleaseRow;
  updates: Awaited<ReturnType<OtaReleaseRepo['listOriginalUpdates']>>;
  isUnchanged: boolean;
}

/** An approval that let a protected head change: the request and who approved, in which role. */
interface ApplyingApproval {
  requestId: string;
  approvers: { userId: string; roleId: string | null }[];
}

const ChangeOutcomes = { applied: 'applied', pendingApproval: 'pending_approval' } as const;

/**
 * What each channel serves (OTA design §5). Promotion points a channel's heads at a
 * `ready` release's updates. An unprotected channel changes at once; a protected one only
 * through an approved `ota.channel_change` request whose pinned action is applied by the
 * handler (invariant 6). `applyPromotion` is the only head writer and refuses a
 * protected channel without an approval.
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

  /** Whether `release` may be promoted to `channel` now: ready, and not older than any head. */
  private async checkPromotion(app: OtaAppRow, channel: OtaChannelRow, releaseId: string): Promise<CheckedPromotion> {
    const release = await this.requireRelease(app, releaseId);
    if (release.status !== OtaReleaseStatuses.ready) {
      throw new OtaReleaseNotReadyError(release.id, release.status);
    }
    const updates = await this.deps.releases.listOriginalUpdates(release.id);
    const heads = await this.deps.heads.listForChannel(
      channel.id,
      release.runtimeVersion,
      updates.map(update => update.platform),
    );
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
    return { release, updates, isUnchanged };
  }

  /** The only head writer. A protected channel needs the approval that allowed it. */
  private async applyPromotion(
    app: OtaAppRow,
    channel: OtaChannelRow,
    checked: CheckedPromotion,
    actor: ChannelActor,
    reason: string | null,
    approval: ApplyingApproval | null,
  ): Promise<void> {
    if (channel.isProtected && approval === null) {
      throw new OtaChannelProtectedError(channel.name);
    }
    const { release, updates } = checked;
    await this.deps.heads.promote({
      workspaceId: app.workspaceId,
      channelId: channel.id,
      releaseId: release.id,
      runtimeVersion: release.runtimeVersion,
      updates: updates.map(update => ({ platform: update.platform, updateId: update.id })),
      actorUserId: actor.userId,
      actorPrincipal: actor.principal,
      approvalRequestId: approval?.requestId ?? null,
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
        platforms: updates.map(update => update.platform),
        principal: actor.principal,
        approvalRequestId: approval?.requestId ?? null,
        approvers: approval?.approvers ?? [],
        reason,
      },
    });
  }

  /** Publish a promotion event for notifications. Best effort: it never undoes the change. */
  private async notify(
    type: (typeof OtaEventTypes)[keyof typeof OtaEventTypes],
    app: OtaAppRow,
    channel: OtaChannelRow,
    release: OtaReleaseRow,
    subject: { requestId: string; requestedBy: string },
  ): Promise<void> {
    const { events } = this.deps;
    if (events === undefined) {
      return;
    }
    await publishBestEffort(events, type, async () => ({
      type,
      workspaceId: app.workspaceId,
      projectId: app.projectId,
      subject: { type: 'approval_request', id: subject.requestId },
      payload: {
        facts: { app: app.id, channel: channel.name, release: release.id },
        message: promotionMessage(type, { app, channel, release, ...subject }, this.deps.appOrigin),
      },
    }));
  }

  /** Apply now (open channel) or ask for approval (protected channel). */
  private async promoteTo(
    app: OtaAppRow,
    channel: OtaChannelRow,
    releaseId: string,
    actor: ChannelActor,
    reason: string | null,
  ): Promise<PromotionResult> {
    const checked = await this.checkPromotion(app, channel, releaseId);
    const result = {
      channel: channel.name,
      releaseId: checked.release.id,
      platforms: checked.updates.map(update => update.platform),
    };
    if (checked.isUnchanged) {
      return { ...result, changed: false, outcome: ChangeOutcomes.applied, requestId: null };
    }
    if (!channel.isProtected) {
      await this.applyPromotion(app, channel, checked, actor, reason, null);
      return { ...result, changed: true, outcome: ChangeOutcomes.applied, requestId: null };
    }
    const subjectType = OtaHostingApprovalSubjects.channelChange;
    // One pending change per channel: a newer request replaces older ones.
    await this.deps.approvals.supersedePending(app.workspaceId, subjectType, channel.id, actor.userId);
    const request = await this.deps.approvals.request(app.workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType,
      subjectId: channel.id,
      action: {
        kind: OtaDeploymentKinds.promote,
        channelId: channel.id,
        releaseId: checked.release.id,
        reason,
        principal: actor.principal,
      },

      requirements: gateRequirementsSchema.parse(channel.policy),
      requestedByUserId: actor.userId ?? actor.actingUserId,
    });
    await this.notify(OtaEventTypes.otaPromotionRequested, app, channel, checked.release, {
      requestId: request.id,
      requestedBy: actor.principal ?? 'a console user',
    });
    return { ...result, changed: false, outcome: ChangeOutcomes.pendingApproval, requestId: request.id };
  }

  /**
   * The `ota.channel_change` approval handler: apply the pinned promotion with the
   * approvers on record. If it can no longer apply (the release was disabled, or the
   * channel moved past it), nothing changes and the failure is audited.
   */
  async applyApproved(request: ApprovalRequestRow): Promise<void> {
    const action = pinnedChangeSchema.parse(request.action);
    const channel = await this.deps.channels.getInWorkspace(request.workspaceId, action.channelId);
    const app = await this.deps.apps.findById(channel.appId);
    if (app === undefined) {
      return;
    }
    let checked: CheckedPromotion;
    try {
      checked = await this.checkPromotion(app, channel, action.releaseId);
    } catch (error) {
      if (error instanceof BadRequestError || error instanceof ConflictError || error instanceof NotFoundError) {
        await this.deps.audit.record(request.workspaceId, {
          actorUserId: null,
          action: AuditActions.otaChannelChangeFailed,
          subjectType: 'ota_channel',
          subjectId: channel.id,
          payload: { approvalRequestId: request.id, reason: error.message },
        });
        return;
      }
      throw error;
    }
    if (checked.isUnchanged) {
      return;
    }
    const { votes } = await this.deps.approvals.get(request.workspaceId, request.id);
    const approvers = votes
      .filter(vote => vote.decision === ApprovalDecisions.approve)
      .map(vote => ({ userId: vote.userId, roleId: vote.roleId }));
    await this.applyPromotion(
      app,
      channel,
      checked,
      { userId: request.requestedByUserId, principal: action.principal, actingUserId: null },
      action.reason,
      { requestId: request.id, approvers },
    );
    await this.notify(OtaEventTypes.otaPromotionApproved, app, channel, checked.release, {
      requestId: request.id,
      requestedBy: action.principal ?? 'a console user',
    });
  }

  /** Tell the channel's watchers a promotion request was rejected. */
  async notifyRejected(request: ApprovalRequestRow): Promise<void> {
    const action = pinnedChangeSchema.parse(request.action);
    const channel = await this.deps.channels.getInWorkspace(request.workspaceId, action.channelId);
    const app = await this.deps.apps.findById(channel.appId);
    if (app === undefined) {
      return;
    }
    const release = await this.requireRelease(app, action.releaseId);
    await this.notify(OtaEventTypes.otaPromotionRejected, app, channel, release, {
      requestId: request.id,
      requestedBy: action.principal ?? 'a console user',
    });
  }

  /** The state of a promotion request, for CI waiting on it (`promote --wait`). */
  async promotionState(appId: string, requestId: string): Promise<{ requestId: string; state: string }> {
    const app = await this.deps.apps.findById(appId);
    if (app === undefined) {
      throw new OtaAppNotFoundError(appId);
    }
    const { request } = await this.deps.approvals.get(app.workspaceId, requestId);
    if (request.subjectType !== OtaHostingApprovalSubjects.channelChange) {
      throw new OtaReleaseNotFoundError(requestId);
    }
    const action = pinnedChangeSchema.parse(request.action);
    const channel = await this.deps.channels.getInWorkspace(app.workspaceId, action.channelId);
    if (channel.appId !== app.id) {
      throw new OtaReleaseNotFoundError(requestId);
    }
    return { requestId: request.id, state: request.state };
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
    return await this.promoteTo(
      app,
      channel,
      releaseId,
      { userId: actorUserId, principal: null, actingUserId: null },
      reason,
    );
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
      { userId: null, principal: `apikey:${principal.keyId}`, actingUserId: principal.createdByUserId },
      reason,
    );
  }

  /** Promote the release an upload session uploaded, within the session's allowed channels. */
  async promoteAsSession(
    session: UploadSessionRow,
    releaseId: string,
    channelName: string,
    reason: string | null,
  ): Promise<PromotionResult> {
    if (session.releaseId !== releaseId) {
      throw new OtaReleaseNotFoundError(releaseId);
    }
    if (session.allowedChannels !== null && !session.allowedChannels.includes(channelName)) {
      throw new OtaChannelNotAllowedError(channelName, session.allowedChannels);
    }
    const app = await this.deps.apps.findById(session.appId);
    if (app === undefined) {
      throw new OtaAppNotFoundError(session.appId);
    }
    const channel = await this.deps.channels.findByName(app.id, channelName);
    if (channel === undefined) {
      throw new OtaChannelNotFoundError(channelName);
    }
    return await this.promoteTo(
      app,
      channel,
      releaseId,
      { userId: null, principal: session.principal, actingUserId: session.actingUserId },
      reason,
    );
  }

  /** The status of the release an upload session uploaded. */
  async releaseStatusAsSession(session: UploadSessionRow, releaseId: string) {
    if (session.releaseId !== releaseId) {
      throw new OtaReleaseNotFoundError(releaseId);
    }
    const app = await this.deps.apps.findById(session.appId);
    if (app === undefined) {
      throw new OtaAppNotFoundError(session.appId);
    }
    const release = await this.requireRelease(app, releaseId);
    return { id: release.id, status: release.status, runtimeVersion: release.runtimeVersion };
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

  /**
   * What promoting `releaseId` to a channel would change, per platform: the update it
   * replaces, and the assets devices would download that they don't have yet.
   */
  async previewPromotion(app: OtaAppRow, channelId: string, releaseId: string): Promise<PromotionPreview> {
    const channel = await this.deps.channels.getInApp(app.workspaceId, app.id, channelId);
    const release = await this.requireRelease(app, releaseId);
    const updates = await this.deps.releases.listOriginalUpdates(release.id);
    const heads = await this.deps.heads.listForChannel(
      channel.id,
      release.runtimeVersion,
      updates.map(update => update.platform),
    );
    const platforms = await Promise.all(
      updates.map(async update => {
        const head = heads.find(candidate => candidate.platform === update.platform);
        const next = await this.deps.releases.assetHashesOf(update.id);
        const current = head?.activeUpdateId == null ? [] : await this.deps.releases.assetHashesOf(head.activeUpdateId);
        const added = next.filter(hash => !current.includes(hash));
        const sizes = await this.deps.assets.listWithObjects(app.id, added);
        return {
          platform: update.platform,
          replacesUpdateId: head?.activeUpdateId ?? null,
          newAssets: added.length,
          newBytes: sizes.reduce((sum, entry) => sum + entry.asset.sizeBytes, 0),
          removedAssets: current.filter(hash => !next.includes(hash)).length,
        };
      }),
    );
    return { channel: channel.name, releaseId: release.id, platforms };
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
