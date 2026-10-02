import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ApprovalKinds, gateRequirementsSchema } from '@mocco/common/governance';
import { ChannelPolicyOutcomes, OtaHostingApprovalSubjects } from '@mocco/common/ota-hosting';
import { AppPlatforms } from '@mocco/common/project';
import { z } from 'zod';

import {
  NotAReactNativeAppError,
  OtaAppAlreadyExistsError,
  OtaAppNotFoundError,
  OtaChannelChangedError,
  OtaChannelNameTakenError,
  OtaChannelNotFoundError,
} from '@backend/domain/ota/errors';
import { EntityNotFoundError, UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ApprovalRequestRow, ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { OtaAppRepo, OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { OtaChannelRepo, OtaChannelRow } from '@backend/domain/ota/repos/ota-channel.repo';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { GateRequirements } from '@mocco/common/governance';
import type { ChannelPolicyOutcome, OtaAppDto, OtaChannelCreateInput, OtaChannelDto } from '@mocco/common/ota-hosting';

export interface OtaHostingServiceDeps {
  apps: OtaAppRepo;
  channels: OtaChannelRepo;
  projects: ProjectService;
  approvals: ApprovalService;
  audit: AuditService;
  /** The public API base the device-facing URLs live under, e.g. `https://api.mocco.club/v1`
   * or `https://www.mocco.club/api/ext/v1`. Baked into signed manifests, so it must be stable. */
  publicApiBase: string;
  now?: () => Date;
}

/** The pinned action of a channel-policy approval — exactly what the handler applies. */
const pinnedPolicySchema = z.object({
  channelId: z.uuid(),
  policy: gateRequirementsSchema.nullable(),
  expectedUpdatedAt: z.iso.datetime(),
});

export const manifestUrlOf = (publicApiBase: string, appId: string) => `${publicApiBase}/ota/apps/${appId}/manifest`;
export const assetBaseUrlOf = (publicApiBase: string, appId: string) => `${publicApiBase}/ota/apps/${appId}/assets`;

const isSamePolicy = (a: GateRequirements | null, b: GateRequirements | null) =>
  JSON.stringify(a === null ? null : gateRequirementsSchema.parse(a)) ===
  JSON.stringify(b === null ? null : gateRequirementsSchema.parse(b));

export function toChannelDto(row: OtaChannelRow): OtaChannelDto {
  return {
    id: row.id,
    appId: row.appId,
    name: row.name,
    isProtected: row.isProtected,
    policy: row.policy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Mocco-hosted OTA setup (ADR 0021): a project's React Native app becomes an OTA app with
 * fixed device-facing URLs, and gets channels. A channel's protection policy says who
 * must approve promotions to it. Protecting a channel applies at once; changing or
 * removing an existing protection is itself approved under the current policy (ADR 0020).
 */
export class OtaHostingService {
  private readonly now: () => Date;

  constructor(private readonly deps: OtaHostingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
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

  private async applyPolicy(
    workspaceId: string,
    channel: OtaChannelRow,
    policy: GateRequirements | null,
    actorUserId: string | null,
    approvalRequestId: string | null,
  ): Promise<OtaChannelRow | undefined> {
    const updated = await this.deps.channels.setPolicyIfUnchanged(channel.id, policy, channel.updatedAt, this.now());
    if (updated !== undefined) {
      // Pending promotions were asked under the old policy; a new policy supersedes them (invariant 8).
      await this.deps.approvals.supersedePending(
        workspaceId,
        OtaHostingApprovalSubjects.channelChange,
        channel.id,
        actorUserId,
      );
      await this.deps.audit.record(workspaceId, {
        actorUserId,
        action: AuditActions.otaChannelPolicyChanged,
        subjectType: 'ota_channel',
        subjectId: channel.id,
        payload: { before: channel.policy, after: policy, approvalRequestId },
      });
    }
    return updated;
  }

  toAppDto(row: OtaAppRow): OtaAppDto {
    return {
      id: row.id,
      projectId: row.projectId,
      projectAppId: row.projectAppId,
      protocol: row.protocol,
      assetBaseUrl: row.assetBaseUrl,
      manifestUrl: manifestUrlOf(this.deps.publicApiBase, row.id),
      signingRequired: row.signingRequired,
      createdAt: row.createdAt,
    };
  }

  /** The project's OTA app, or throw OtaAppNotFoundError. */
  async requireApp(workspaceId: string, projectId: string, appId: string): Promise<OtaAppRow> {
    try {
      return await this.deps.apps.getInProject(workspaceId, projectId, appId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new OtaAppNotFoundError(appId, { cause: error });
      }
      throw error;
    }
  }

  async listApps(workspaceId: string, projectId: string): Promise<OtaAppDto[]> {
    await this.deps.projects.requireProject(workspaceId, projectId);
    const rows = await this.deps.apps.listByProject(workspaceId, projectId);
    return rows.map(row => this.toAppDto(row));
  }

  /** Host OTA updates for a React Native project app. Its URLs are fixed from now on. */
  async createApp(workspaceId: string, projectId: string, actorUserId: string, projectAppId: string) {
    const projectApp = await this.deps.projects.requireApp(workspaceId, projectId, projectAppId);
    if (projectApp.platform !== AppPlatforms.reactNative) {
      throw new NotAReactNativeAppError(projectAppId);
    }
    const id = randomUUID();
    let row: OtaAppRow;
    try {
      row = await this.deps.apps.insert({
        id,
        workspaceId,
        projectId,
        projectAppId,
        assetBaseUrl: assetBaseUrlOf(this.deps.publicApiBase, id),
        createdByUserId: actorUserId,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new OtaAppAlreadyExistsError({ cause: error });
      }
      throw error;
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.otaAppCreated,
      subjectType: 'ota_app',
      subjectId: row.id,
      payload: { projectId, projectAppId, assetBaseUrl: row.assetBaseUrl },
    });
    return this.toAppDto(row);
  }

  async listChannels(app: OtaAppRow): Promise<OtaChannelDto[]> {
    const rows = await this.deps.channels.listByApp(app.workspaceId, app.id);
    return rows.map(row => toChannelDto(row));
  }

  async createChannel(app: OtaAppRow, actorUserId: string, input: OtaChannelCreateInput): Promise<OtaChannelDto> {
    let row: OtaChannelRow;
    try {
      row = await this.deps.channels.insert({
        workspaceId: app.workspaceId,
        appId: app.id,
        name: input.name,
        isProtected: input.policy !== null,
        policy: input.policy,
        // Millisecond timestamps from the service clock, so `updatedAt` round-trips exactly
        // through a JS Date for the optimistic-concurrency check (Postgres now() has microseconds).
        createdAt: this.now(),
        updatedAt: this.now(),
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new OtaChannelNameTakenError(input.name, { cause: error });
      }
      throw error;
    }
    await this.deps.audit.record(app.workspaceId, {
      actorUserId,
      action: AuditActions.otaChannelCreated,
      subjectType: 'ota_channel',
      subjectId: row.id,
      payload: { appId: app.id, name: row.name, policy: row.policy },
    });
    return toChannelDto(row);
  }

  /**
   * Change a channel's protection. An unprotected channel gets its policy at once. A
   * protected channel's policy changes (or is removed) only through an approval under the
   * current policy; older pending requests for the channel are superseded.
   */
  async changeChannelPolicy(
    app: OtaAppRow,
    actorUserId: string,
    channelId: string,
    policy: GateRequirements | null,
  ): Promise<{ outcome: ChannelPolicyOutcome; channel: OtaChannelDto; requestId: string | null }> {
    const channel = await this.requireChannel(app, channelId);
    const current = channel.policy ?? null;
    if (isSamePolicy(current, policy)) {
      return { outcome: ChannelPolicyOutcomes.applied, channel: toChannelDto(channel), requestId: null };
    }
    if (current === null) {
      const updated = await this.applyPolicy(app.workspaceId, channel, policy, actorUserId, null);
      if (updated === undefined) {
        throw new OtaChannelChangedError();
      }
      return { outcome: ChannelPolicyOutcomes.applied, channel: toChannelDto(updated), requestId: null };
    }
    const subjectType = OtaHostingApprovalSubjects.channelPolicy;
    await this.deps.approvals.supersedePending(app.workspaceId, subjectType, channel.id, actorUserId);
    const request = await this.deps.approvals.request(app.workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType,
      subjectId: channel.id,
      action: { channelId: channel.id, policy, expectedUpdatedAt: channel.updatedAt.toISOString() },
      requirements: current,
      requestedByUserId: actorUserId,
    });
    return { outcome: ChannelPolicyOutcomes.pendingApproval, channel: toChannelDto(channel), requestId: request.id };
  }

  /** The approval handler for `ota.channel_policy`: apply the pinned policy, unless the
   * channel changed since the request (then the stale approval is audited, nothing applied). */
  async applyApprovedPolicy(request: ApprovalRequestRow): Promise<void> {
    const action = pinnedPolicySchema.parse(request.action);
    const channel = await this.deps.channels.getInWorkspace(request.workspaceId, action.channelId);
    const isFresh = channel.updatedAt.toISOString() === action.expectedUpdatedAt;
    const updated = isFresh
      ? await this.applyPolicy(request.workspaceId, channel, action.policy, request.requestedByUserId, request.id)
      : undefined;
    if (updated === undefined) {
      await this.deps.audit.record(request.workspaceId, {
        actorUserId: null,
        action: AuditActions.otaChannelPolicyApprovalStale,
        subjectType: 'ota_channel',
        subjectId: channel.id,
        payload: { approvalRequestId: request.id },
      });
    }
  }
}
