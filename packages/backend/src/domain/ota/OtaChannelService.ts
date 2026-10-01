import { AuditActions } from '@mocco/common/audit';
import { OtaEventTypes } from '@mocco/common/events';
import { ApprovalDecisions, ApprovalKinds, gateRequirementsSchema } from '@mocco/common/governance';
import {
  ChannelPolicyOutcomes,
  FULL_ROLLOUT_BP,
  OtaDeploymentKinds,
  OtaHostingApprovalSubjects,
  OtaReleaseStatuses,
} from '@mocco/common/ota-hosting';
import { z } from 'zod';

import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';
import { publishBestEffort } from '@backend/domain/events/ports';
import {
  OtaAppNotFoundError,
  OtaChannelNotAllowedError,
  OtaChannelNotFoundError,
  OtaChannelProtectedError,
  OtaNothingToChangeError,
  OtaReleaseNotFoundError,
  OtaReleaseNotReadyError,
  OtaReleaseOlderThanHeadError,
  OtaRollbackUnavailableError,
} from '@backend/domain/ota/errors';
import { promotionMessage } from '@backend/domain/ota/promotion-message';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { ApiPrincipal } from '@backend/domain/apikey/ApiKeyService';
import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { ApprovalRequestRow, ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { ChannelHeadDetail, ChannelHeadRepo, HeadWrite } from '@backend/domain/ota/repos/channel-head.repo';
import type { OtaAppRepo, OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { OtaAssetRepo } from '@backend/domain/ota/repos/ota-asset.repo';
import type { OtaChannelRepo, OtaChannelRow } from '@backend/domain/ota/repos/ota-channel.repo';
import type { OtaReleaseRepo, OtaReleaseRow } from '@backend/domain/ota/repos/ota-release.repo';
import type { UploadSessionRow } from '@backend/domain/ota/repos/upload-session.repo';
import type { ChannelStateCache } from '@backend/domain/ota/serving/state-cache';
import type {
  OtaChannelHeadDto,
  OtaDeploymentKind,
  OtaPlatform,
  PromotionPreview,
  PromotionResult,
  StopAction,
} from '@mocco/common/ota-hosting';

export interface ChannelServiceDeps {
  apps: OtaAppRepo;
  channels: OtaChannelRepo;
  releases: OtaReleaseRepo;
  heads: ChannelHeadRepo;
  assets: OtaAssetRepo;
  approvals: ApprovalService;
  audit: AuditService;
  cache: ChannelStateCache;
  /** Where approval requests and decisions are published (notifications). */
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

/**
 * A change that moves devices forward — gated on a protected channel. Pinned on its
 * approval request, and re-planned when the approval lands.
 */
const channelChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(OtaDeploymentKinds.promote),
    channelId: z.uuid(),
    releaseId: z.uuid(),
    /** 10000 promotes fully; less starts a rollout of the release as the candidate. */
    rolloutBp: z.number().int().min(1).max(FULL_ROLLOUT_BP),
    reason: z.string().nullable(),
    principal: z.string().nullable(),
  }),
  z.object({
    kind: z.literal(OtaDeploymentKinds.rollout),
    channelId: z.uuid(),
    runtimeVersion: z.string().nullable(),
    rolloutBp: z
      .number()
      .int()
      .min(1)
      .max(FULL_ROLLOUT_BP - 1),
    reason: z.string().nullable(),
    principal: z.string().nullable(),
  }),
  z.object({
    kind: z.enum([OtaDeploymentKinds.complete, OtaDeploymentKinds.resume]),
    channelId: z.uuid(),
    runtimeVersion: z.string().nullable(),
    reason: z.string().nullable(),
    principal: z.string().nullable(),
  }),
]);
export type ChannelChange = z.infer<typeof channelChangeSchema>;

/** The heads a change writes and the deployment that records it. */
interface ChangePlan {
  kind: OtaDeploymentKind;
  writes: HeadWrite[];
  /** The release the change is about (the promoted, rolled-out or rolled-back one). */
  release: OtaReleaseRow | null;
  fromBp: number | null;
  toBp: number | null;
}

/** What a stop action acts on, and why. */
export interface StopInput {
  runtimeVersion: string | null;
  platform?: OtaPlatform | null;
  reason: string | null;
}

/** An approval that let a protected head change: the request and who approved, in which role. */
interface ApplyingApproval {
  requestId: string;
  approvers: { userId: string; roleId: string | null }[];
}

/** What a change of each kind is called in messages. */
const changeLabels: Record<ChannelChange['kind'], string> = {
  [OtaDeploymentKinds.promote]: 'Promote',
  [OtaDeploymentKinds.rollout]: 'Change the rollout of',
  [OtaDeploymentKinds.complete]: 'Complete the rollout of',
  [OtaDeploymentKinds.resume]: 'Resume the rollout of',
};

const STOP_KINDS = new Set<OtaDeploymentKind>([
  OtaDeploymentKinds.pause,
  OtaDeploymentKinds.rollback,
  OtaDeploymentKinds.rollbackEmbedded,
]);

/** Which heads a change acts on: one runtime version (or all), and one platform (or both). */
interface HeadScope {
  runtimeVersion: string | null;
  platform?: OtaPlatform | null;
}

const isInScope = (scope: HeadScope) => (detail: ChannelHeadDetail) =>
  (scope.runtimeVersion === null || detail.head.runtimeVersion === scope.runtimeVersion) &&
  (scope.platform == null || detail.head.platform === scope.platform);

const isOnRuntime = (runtimeVersion: string | null) => isInScope({ runtimeVersion });

/**
 * What each channel serves (OTA design §5). Changes that move devices forward — promote
 * (fully or as a rollout), set the rollout, complete, resume — apply at once on an open
 * channel and through an approved `ota.channel_change` request on a protected one
 * (invariant 6). The stop actions — pause, rollback, rollback to embedded — are never
 * gated. `apply` is the only head writer: it refuses a gated change of a protected
 * channel without its approval, and every change appends a deployment and an audit entry.
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

  private async requireChannel(app: OtaAppRow, channelId: string): Promise<OtaChannelRow> {
    try {
      return await this.deps.channels.getInApp(app.workspaceId, app.id, channelId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new OtaChannelNotFoundError(channelId, { cause: error });
      }
      throw error;
    }
  }

  private async requireChannelNamed(app: OtaAppRow, name: string): Promise<OtaChannelRow> {
    const channel = await this.deps.channels.findByName(app.id, name);
    if (channel === undefined) {
      throw new OtaChannelNotFoundError(name);
    }
    return channel;
  }

  /** Promote `releaseId`: ready, and not older than what any head serves or rolls out. */
  private async planPromotion(
    app: OtaAppRow,
    channel: OtaChannelRow,
    releaseId: string,
    rolloutBp: number,
  ): Promise<ChangePlan | null> {
    const release = await this.requireRelease(app, releaseId);
    if (release.status !== OtaReleaseStatuses.ready) {
      throw new OtaReleaseNotReadyError(release.id, release.status);
    }
    const updates = await this.deps.releases.listOriginalUpdates(release.id);
    const allHeads = await this.deps.heads.listHeadsOfChannel(channel.id);
    const heads = allHeads.filter(detail => detail.head.runtimeVersion === release.runtimeVersion);
    const isFull = rolloutBp >= FULL_ROLLOUT_BP;
    const writes = updates.flatMap(update => {
      const detail = heads.find(candidate => candidate.head.platform === update.platform);
      const newest = [detail?.active, detail?.candidate].find(
        served => served != null && served.id !== update.id && served.commitTime >= update.commitTime,
      );
      if (newest != null) {
        throw new OtaReleaseOlderThanHeadError(channel.name, update.platform);
      }
      const isServed = isFull
        ? detail?.active?.id === update.id && detail.candidate === null && detail.head.serveDirectiveId === null
        : detail?.candidate?.id === update.id && detail.head.rolloutBp === rolloutBp;
      if (isServed) {
        return [];
      }
      const write: HeadWrite = isFull
        ? {
            platform: update.platform,
            runtimeVersion: release.runtimeVersion,
            activeUpdateId: update.id,
            previousUpdateId: detail?.active?.id ?? null,
            candidateUpdateId: null,
            rolloutBp: 0,
            isPaused: false,
            serveDirectiveId: null,
          }
        : {
            platform: update.platform,
            runtimeVersion: release.runtimeVersion,
            candidateUpdateId: update.id,
            rolloutBp,
            isPaused: false,
            serveDirectiveId: null,
          };
      return [write];
    });
    if (writes.length === 0) {
      return null;
    }
    return {
      kind: isFull ? OtaDeploymentKinds.promote : OtaDeploymentKinds.rollout,
      writes,
      release,
      fromBp: null,
      toBp: rolloutBp,
    };
  }

  /** Plan a change of the rollout in progress (set %, complete, resume, pause). */
  private async planRolloutChange(
    app: OtaAppRow,
    channel: OtaChannelRow,
    kind: OtaDeploymentKind,
    runtimeVersion: string | null,
    rolloutBp: number | null,
  ): Promise<ChangePlan> {
    const allHeads = await this.deps.heads.listHeadsOfChannel(channel.id);
    const rolling = allHeads.filter(isOnRuntime(runtimeVersion)).filter(detail => detail.candidate !== null);
    if (rolling.length === 0) {
      throw new OtaNothingToChangeError(`"${channel.name}" has no rollout in progress`);
    }
    const [first] = rolling;
    const release = first?.candidate == null ? null : await this.requireRelease(app, first.candidate.releaseId);
    const writes = rolling.map((detail): HeadWrite => {
      const at = { platform: detail.head.platform, runtimeVersion: detail.head.runtimeVersion };
      if (kind === OtaDeploymentKinds.complete) {
        return {
          ...at,
          activeUpdateId: detail.candidate?.id ?? null,
          previousUpdateId: detail.active?.id ?? null,
          candidateUpdateId: null,
          rolloutBp: 0,
          isPaused: false,
        };
      }
      if (kind === OtaDeploymentKinds.pause || kind === OtaDeploymentKinds.resume) {
        return { ...at, isPaused: kind === OtaDeploymentKinds.pause };
      }
      return { ...at, rolloutBp: rolloutBp ?? detail.head.rolloutBp };
    });
    return {
      kind,
      writes,
      release,
      fromBp: first?.head.rolloutBp ?? null,
      toBp: kind === OtaDeploymentKinds.complete ? FULL_ROLLOUT_BP : rolloutBp,
    };
  }

  /**
   * Plan a rollback: per head, serve the pre-signed republish of what it served before —
   * newer than the bad update, so devices on it take it. During a rollout that is the
   * active update's content, valid for devices on the candidate (abort = rollback).
   */
  private async planRollback(channel: OtaChannelRow, scope: HeadScope): Promise<ChangePlan> {
    const allHeads = await this.deps.heads.listHeadsOfChannel(channel.id);
    const heads = allHeads.filter(isInScope(scope));
    const plans = await Promise.all(
      heads
        .filter(detail => detail.active !== null || detail.candidate !== null)
        .map(async detail => await this.rollbackOf(channel, detail)),
    );
    if (plans.length === 0) {
      throw new OtaNothingToChangeError(`"${channel.name}" serves nothing to roll back`);
    }
    const [first] = plans;
    return {
      kind: OtaDeploymentKinds.rollback,
      writes: plans.map(plan => plan.write),
      release: first?.from ?? null,
      fromBp: null,
      toBp: null,
    };
  }

  /** The update a head served before its active one, if it is still known. */
  private async previousOf(head: ChannelHeadDetail['head']) {
    return head.previousUpdateId === null ? undefined : await this.deps.releases.findUpdate(head.previousUpdateId);
  }

  private async rollbackOf(
    channel: OtaChannelRow,
    detail: ChannelHeadDetail,
  ): Promise<{ write: HeadWrite; from: OtaReleaseRow | null }> {
    const { head } = detail;
    const bad = detail.candidate ?? detail.active;
    // During a rollout, go back to the active update; otherwise to what it replaced.
    const backTo = detail.candidate === null ? await this.previousOf(head) : detail.active;
    const republish =
      bad == null || backTo == null
        ? undefined
        : await this.deps.releases.findRepublish(bad.id, backTo.contentOfUpdateId);
    if (bad == null || republish === undefined) {
      throw new OtaRollbackUnavailableError(channel.name, head.platform);
    }
    const from = (await this.deps.releases.findById(bad.releaseId)) ?? null;
    return {
      write: {
        platform: head.platform,
        runtimeVersion: head.runtimeVersion,
        activeUpdateId: republish.id,
        previousUpdateId: bad.id,
        candidateUpdateId: null,
        rolloutBp: 0,
        isPaused: false,
        serveDirectiveId: null,
      },
      from,
    };
  }

  /** Plan a rollback to the embedded bundle: serve the pre-signed directive of what devices run. */
  private async planRollbackToEmbedded(channel: OtaChannelRow, scope: HeadScope): Promise<ChangePlan> {
    const allHeads = await this.deps.heads.listHeadsOfChannel(channel.id);
    const heads = allHeads
      .filter(isInScope(scope))
      .filter(detail => detail.active !== null || detail.candidate !== null);
    if (heads.length === 0) {
      throw new OtaNothingToChangeError(`"${channel.name}" serves nothing to roll back`);
    }
    const writes = await Promise.all(
      heads.map(async (detail): Promise<HeadWrite> => {
        const served = detail.candidate ?? detail.active;
        const directive = served == null ? undefined : await this.deps.releases.findRollBackToEmbedded(served.id);
        if (directive === undefined) {
          throw new OtaRollbackUnavailableError(channel.name, detail.head.platform, { isToEmbedded: true });
        }
        return {
          platform: detail.head.platform,
          runtimeVersion: detail.head.runtimeVersion,
          serveDirectiveId: directive.id,
          candidateUpdateId: null,
          rolloutBp: 0,
          isPaused: false,
        };
      }),
    );
    const [first] = heads;
    const releaseId = (first?.candidate ?? first?.active)?.releaseId;
    return {
      kind: OtaDeploymentKinds.rollbackEmbedded,
      writes,
      release: releaseId === undefined ? null : ((await this.deps.releases.findById(releaseId)) ?? null),
      fromBp: null,
      toBp: null,
    };
  }

  /** Plan a gated change from its pinned form (null when it would change nothing). */
  private async planChange(app: OtaAppRow, channel: OtaChannelRow, change: ChannelChange): Promise<ChangePlan | null> {
    if (change.kind === OtaDeploymentKinds.promote) {
      return await this.planPromotion(app, channel, change.releaseId, change.rolloutBp);
    }
    if (change.kind === OtaDeploymentKinds.rollout) {
      return change.rolloutBp >= FULL_ROLLOUT_BP
        ? await this.planRolloutChange(app, channel, OtaDeploymentKinds.complete, change.runtimeVersion, null)
        : await this.planRolloutChange(app, channel, change.kind, change.runtimeVersion, change.rolloutBp);
    }
    return await this.planRolloutChange(app, channel, change.kind, change.runtimeVersion, null);
  }

  /** The only head writer. A gated change of a protected channel needs the approval that allowed it. */
  private async apply(
    app: OtaAppRow,
    channel: OtaChannelRow,
    plan: ChangePlan,
    actor: ChannelActor,
    reason: string | null,
    approval: ApplyingApproval | null,
  ): Promise<void> {
    if (channel.isProtected && approval === null && !STOP_KINDS.has(plan.kind)) {
      throw new OtaChannelProtectedError(channel.name);
    }
    await this.deps.heads.writeHeads({
      workspaceId: app.workspaceId,
      channelId: channel.id,
      writes: plan.writes,
      deployment: {
        releaseId: plan.release?.id ?? null,
        kind: plan.kind,
        fromBp: plan.fromBp,
        toBp: plan.toBp,
        actorUserId: actor.userId,
        actorPrincipal: actor.principal,
        approvalRequestId: approval?.requestId ?? null,
        reason,
      },
      now: this.now(),
    });
    this.deps.cache.invalidateChannel(app.id, channel.name);
    await this.deps.audit.record(app.workspaceId, {
      actorUserId: actor.userId,
      action: AuditActions.otaChannelChanged,
      subjectType: 'ota_channel',
      subjectId: channel.id,
      payload: {
        kind: plan.kind,
        channel: channel.name,
        releaseId: plan.release?.id ?? null,
        platforms: plan.writes.map(write => write.platform),
        fromBp: plan.fromBp,
        toBp: plan.toBp,
        principal: actor.principal,
        approvalRequestId: approval?.requestId ?? null,
        approvers: approval?.approvers ?? [],
        reason,
      },
    });
  }

  /** Publish an approval event for notifications. Best effort: it never undoes the change. */
  private async notify(
    type: Exclude<(typeof OtaEventTypes)[keyof typeof OtaEventTypes], typeof OtaEventTypes.otaEmergencyLaunchSpike>,
    app: OtaAppRow,
    channel: OtaChannelRow,
    subject: { requestId: string; requestedBy: string; change: ChannelChange; release: OtaReleaseRow | null },
  ): Promise<void> {
    const { events } = this.deps;
    if (events === undefined || subject.release === null) {
      return;
    }
    const { release } = subject;
    await publishBestEffort(events, type, async () => ({
      type,
      workspaceId: app.workspaceId,
      projectId: app.projectId,
      subject: { type: 'approval_request', id: subject.requestId },
      payload: {
        facts: { app: app.id, channel: channel.name, release: release.id, change: subject.change.kind },
        message: promotionMessage(
          type,
          { app, channel, release, requestedBy: subject.requestedBy, action: changeLabels[subject.change.kind] },
          this.deps.appOrigin,
        ),
      },
    }));
  }

  /** Apply a forward change now (open channel) or ask for approval (protected channel). */
  private async changeOrRequest(
    app: OtaAppRow,
    channel: OtaChannelRow,
    change: ChannelChange,
    actor: ChannelActor,
  ): Promise<PromotionResult> {
    const plan = await this.planChange(app, channel, change);
    const result = {
      channel: channel.name,
      releaseId: plan?.release?.id ?? (change.kind === OtaDeploymentKinds.promote ? change.releaseId : null),
      platforms: (plan?.writes ?? []).map(write => write.platform),
      kind: plan?.kind ?? change.kind,
    };
    if (plan === null) {
      return { ...result, changed: false, outcome: ChannelPolicyOutcomes.applied, requestId: null };
    }
    if (!channel.isProtected) {
      await this.apply(app, channel, plan, actor, change.reason, null);
      return { ...result, changed: true, outcome: ChannelPolicyOutcomes.applied, requestId: null };
    }
    const subjectType = OtaHostingApprovalSubjects.channelChange;
    // One pending change per channel: a newer request replaces older ones.
    await this.deps.approvals.supersedePending(app.workspaceId, subjectType, channel.id, actor.userId);
    const request = await this.deps.approvals.request(app.workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType,
      subjectId: channel.id,
      action: change,

      requirements: gateRequirementsSchema.parse(channel.policy),
      requestedByUserId: actor.userId ?? actor.actingUserId,
    });
    await this.notify(OtaEventTypes.otaPromotionRequested, app, channel, {
      requestId: request.id,
      requestedBy: actor.principal ?? 'a console user',
      change,
      release: plan.release,
    });
    return { ...result, changed: false, outcome: ChannelPolicyOutcomes.pendingApproval, requestId: request.id };
  }

  private async headDto(channel: OtaChannelRow, detail: ChannelHeadDetail): Promise<OtaChannelHeadDto> {
    const { head } = detail;
    let rollback: Awaited<ReturnType<OtaChannelService['rollbackOf']>> | null = null;
    try {
      rollback = await this.rollbackOf(channel, detail);
    } catch (error) {
      if (!(error instanceof OtaRollbackUnavailableError)) {
        throw error;
      }
    }
    const served = detail.candidate ?? detail.active;
    const directive = served == null ? undefined : await this.deps.releases.findRollBackToEmbedded(served.id);
    // A republish belongs to the release it was signed with; what it serves is its content's release.
    const isRolledBack = detail.active !== null && detail.active.contentOfUpdateId !== detail.active.id;
    const content =
      detail.active === null || !isRolledBack
        ? undefined
        : await this.deps.releases.findUpdate(detail.active.contentOfUpdateId);
    return {
      channelId: channel.id,
      platform: head.platform,
      runtimeVersion: head.runtimeVersion,
      releaseId: content?.releaseId ?? detail.active?.releaseId ?? null,
      isRolledBack,
      candidateReleaseId: detail.candidate?.releaseId ?? null,
      rolloutBp: head.rolloutBp,
      isPaused: head.isPaused,
      isServingEmbedded: head.serveDirectiveId !== null,
      canRollBack: rollback !== null,
      canRollBackToEmbedded: directive !== undefined && head.serveDirectiveId === null,
      updatedAt: head.updatedAt,
    };
  }

  /**
   * The `ota.channel_change` approval handler: re-plan the pinned change and apply it with
   * the approvers on record. If it can no longer apply (the release was disabled, the
   * channel moved past it, the rollout ended), nothing changes and the failure is audited.
   */
  async applyApproved(request: ApprovalRequestRow): Promise<void> {
    const change = channelChangeSchema.parse(request.action);
    const channel = await this.deps.channels.getInWorkspace(request.workspaceId, change.channelId);
    const app = await this.deps.apps.findById(channel.appId);
    if (app === undefined) {
      return;
    }
    let plan: ChangePlan | null;
    try {
      plan = await this.planChange(app, channel, change);
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
    if (plan === null) {
      return;
    }
    const { votes } = await this.deps.approvals.get(request.workspaceId, request.id);
    const approvers = votes
      .filter(vote => vote.decision === ApprovalDecisions.approve)
      .map(vote => ({ userId: vote.userId, roleId: vote.roleId }));
    await this.apply(
      app,
      channel,
      plan,
      { userId: request.requestedByUserId, principal: change.principal, actingUserId: null },
      change.reason,
      { requestId: request.id, approvers },
    );
    await this.notify(OtaEventTypes.otaPromotionApproved, app, channel, {
      requestId: request.id,
      requestedBy: change.principal ?? 'a console user',
      change,
      release: plan.release,
    });
  }

  /** Tell the channel's watchers a change request was rejected. */
  async notifyRejected(request: ApprovalRequestRow): Promise<void> {
    const change = channelChangeSchema.parse(request.action);
    const channel = await this.deps.channels.getInWorkspace(request.workspaceId, change.channelId);
    const app = await this.deps.apps.findById(channel.appId);
    if (app === undefined) {
      return;
    }
    const heads = await this.deps.heads.listHeadsOfChannel(channel.id);
    const releaseId =
      change.kind === OtaDeploymentKinds.promote
        ? change.releaseId
        : heads.find(detail => detail.candidate !== null)?.candidate?.releaseId;
    const release = releaseId === undefined ? null : ((await this.deps.releases.findById(releaseId)) ?? null);
    await this.notify(OtaEventTypes.otaPromotionRejected, app, channel, {
      requestId: request.id,
      requestedBy: change.principal ?? 'a console user',
      change,
      release,
    });
  }

  /** Promote from the console: fully, or as a rollout to `rolloutBp` of devices. */
  async promote(
    app: OtaAppRow,
    channelId: string,
    releaseId: string,
    actorUserId: string,
    reason: string | null,
    rolloutBp = FULL_ROLLOUT_BP,
  ): Promise<PromotionResult> {
    const channel = await this.requireChannel(app, channelId);
    return await this.changeOrRequest(
      app,
      channel,
      { kind: OtaDeploymentKinds.promote, channelId: channel.id, releaseId, rolloutBp, reason, principal: null },
      { userId: actorUserId, principal: null, actingUserId: null },
    );
  }

  /** Set, complete or resume the rollout in progress (gated on a protected channel). */
  async changeRollout(
    app: OtaAppRow,
    channelId: string,
    input: { kind: 'rollout' | 'complete' | 'resume'; rolloutBp?: number; runtimeVersion: string | null },
    actorUserId: string,
    reason: string | null,
  ): Promise<PromotionResult> {
    const channel = await this.requireChannel(app, channelId);
    const base = { channelId: channel.id, runtimeVersion: input.runtimeVersion, reason, principal: null };
    const rolloutBp = input.rolloutBp ?? 1;
    // A share of 100% completes the rollout.
    const isComplete = input.kind === OtaDeploymentKinds.complete || rolloutBp >= FULL_ROLLOUT_BP;
    let change: ChannelChange;
    if (input.kind === OtaDeploymentKinds.resume) {
      change = { ...base, kind: OtaDeploymentKinds.resume };
    } else if (isComplete) {
      change = { ...base, kind: OtaDeploymentKinds.complete };
    } else {
      change = { ...base, kind: OtaDeploymentKinds.rollout, rolloutBp };
    }
    return await this.changeOrRequest(app, channel, change, {
      userId: actorUserId,
      principal: null,
      actingUserId: null,
    });
  }

  /** Pause, roll back, or roll back to embedded — never gated, always audited. */
  async stop(
    app: OtaAppRow,
    channel: OtaChannelRow,
    action: StopAction,
    actor: ChannelActor,
    input: StopInput,
  ): Promise<PromotionResult> {
    const scope = { runtimeVersion: input.runtimeVersion, platform: input.platform ?? null };
    let plan: ChangePlan;
    if (action === OtaDeploymentKinds.pause) {
      plan = await this.planRolloutChange(app, channel, OtaDeploymentKinds.pause, input.runtimeVersion, null);
    } else if (action === OtaDeploymentKinds.rollback) {
      plan = await this.planRollback(channel, scope);
    } else {
      plan = await this.planRollbackToEmbedded(channel, scope);
    }
    await this.apply(app, channel, plan, actor, input.reason, null);
    return {
      channel: channel.name,
      releaseId: plan.release?.id ?? null,
      platforms: plan.writes.map(write => write.platform),
      kind: plan.kind,
      changed: true,
      outcome: ChannelPolicyOutcomes.applied,
      requestId: null,
    };
  }

  /** A stop action from the console. */
  async stopFromConsole(
    app: OtaAppRow,
    channelId: string,
    action: StopAction,
    actorUserId: string,
    input: StopInput,
  ): Promise<PromotionResult> {
    const channel = await this.requireChannel(app, channelId);
    return await this.stop(app, channel, action, { userId: actorUserId, principal: null, actingUserId: null }, input);
  }

  /** A stop action from CI with a secret API key (e.g. `mocco-ota rollback`). */
  async stopAsKey(
    principal: ApiPrincipal,
    appId: string,
    channelName: string,
    action: StopAction,
    input: StopInput,
  ): Promise<PromotionResult> {
    const app = await this.requireKeyApp(principal, appId);
    const channel = await this.requireChannelNamed(app, channelName);
    return await this.stop(
      app,
      channel,
      action,
      { userId: null, principal: `apikey:${principal.keyId}`, actingUserId: principal.createdByUserId },
      input,
    );
  }

  /** Promote from CI with a secret API key whose project owns the app. */
  async promoteAsKey(
    principal: ApiPrincipal,
    appId: string,
    releaseId: string,
    channelName: string,
    input: { reason: string | null; rolloutBp?: number },
  ): Promise<PromotionResult> {
    const app = await this.requireKeyApp(principal, appId);
    const channel = await this.requireChannelNamed(app, channelName);
    return await this.changeOrRequest(
      app,
      channel,
      {
        kind: OtaDeploymentKinds.promote,
        channelId: channel.id,
        releaseId,
        rolloutBp: input.rolloutBp ?? FULL_ROLLOUT_BP,
        reason: input.reason,
        principal: `apikey:${principal.keyId}`,
      },
      { userId: null, principal: `apikey:${principal.keyId}`, actingUserId: principal.createdByUserId },
    );
  }

  /** Promote the release an upload session uploaded, within the session's allowed channels. */
  async promoteAsSession(
    session: UploadSessionRow,
    releaseId: string,
    channelName: string,
    input: { reason: string | null; rolloutBp?: number },
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
    const channel = await this.requireChannelNamed(app, channelName);
    return await this.changeOrRequest(
      app,
      channel,
      {
        kind: OtaDeploymentKinds.promote,
        channelId: channel.id,
        releaseId,
        rolloutBp: input.rolloutBp ?? FULL_ROLLOUT_BP,
        reason: input.reason,
        principal: session.principal,
      },
      { userId: null, principal: session.principal, actingUserId: session.actingUserId },
    );
  }

  /** The state of a change request, for CI waiting on it (`promote --wait`). */
  async promotionState(appId: string, requestId: string): Promise<{ requestId: string; state: string }> {
    const app = await this.deps.apps.findById(appId);
    if (app === undefined) {
      throw new OtaAppNotFoundError(appId);
    }
    const { request } = await this.deps.approvals.get(app.workspaceId, requestId);
    if (request.subjectType !== OtaHostingApprovalSubjects.channelChange) {
      throw new OtaReleaseNotFoundError(requestId);
    }
    const change = channelChangeSchema.parse(request.action);
    const channel = await this.deps.channels.getInWorkspace(app.workspaceId, change.channelId);
    if (channel.appId !== app.id) {
      throw new OtaReleaseNotFoundError(requestId);
    }
    return { requestId: request.id, state: request.state };
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
    const channel = await this.requireChannel(app, channelId);
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

  /** What every channel head of the app serves and rolls out now, and which rollbacks are pre-signed. */
  async listHeads(app: OtaAppRow): Promise<OtaChannelHeadDto[]> {
    const channels = await this.deps.channels.listByApp(app.workspaceId, app.id);
    const perChannel = await Promise.all(
      channels.map(async channel => {
        const heads = await this.deps.heads.listHeadsOfChannel(channel.id);
        return await Promise.all(heads.map(async detail => await this.headDto(channel, detail)));
      }),
    );
    return perChannel.flat();
  }
}
