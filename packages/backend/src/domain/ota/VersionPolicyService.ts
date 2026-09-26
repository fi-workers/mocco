import { AuditActions } from '@mocco/common/audit';
import { ApprovalKinds } from '@mocco/common/governance';
import {
  classifyPolicyChange,
  OtaApprovalSubjects,
  PolicyDirections,
  isVersionFloorRaised,
  VersionPolicyOutcomes,
  versionPolicyRulesSchema,
} from '@mocco/common/ota';
import { AppPlatforms } from '@mocco/common/project';
import { z } from 'zod';

import {
  NotAStoreAppError,
  StoreLiveAttestationRequiredError,
  VersionPolicyConflictError,
} from '@backend/domain/ota/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ApprovalRequestRow, ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { AppVersionPolicyChangeRepo } from '@backend/domain/ota/repos/app-version-policy-change.repo';
import type { AppVersionPolicyRepo } from '@backend/domain/ota/repos/app-version-policy.repo';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { PolicyDirection, VersionPolicyChangeInput, VersionPolicyRules } from '@mocco/common/ota';

export interface VersionPolicyServiceDeps {
  policies: AppVersionPolicyRepo;
  changes: AppVersionPolicyChangeRepo;
  projects: ProjectService;
  approvals: ApprovalService;
  audit: AuditService;
}

/** Store builds only: a version policy needs a store version and a store link. */
const STORE_PLATFORMS = new Set<string>([AppPlatforms.ios, AppPlatforms.android]);

/** The pinned action of a version-policy pre-approval — exactly what the handler applies. */
const pinnedChangeSchema = z.object({
  projectId: z.uuid(),
  appId: z.uuid(),
  expectedRevision: z.number().int().min(0),
  rules: versionPolicyRulesSchema,
  reason: z.string().nullable(),
});
type PinnedChange = z.infer<typeof pinnedChangeSchema>;

type PolicyRow = NonNullable<Awaited<ReturnType<AppVersionPolicyRepo['find']>>>;

/** The editable rules of a stored policy. */
function rulesOf(row: PolicyRow): VersionPolicyRules {
  return {
    minSupportedVersion: row.minSupportedVersion,
    recommendedVersion: row.recommendedVersion,
    blockedVersions: row.blockedVersions,
    messages: row.messages,
    storeUrl: row.storeUrl,
    softPromptIntervalHours: row.softPromptIntervalHours,
    approvalPolicy: row.approvalPolicy ?? null,
  };
}

/**
 * Version policy and native force update (phase 2 of the OTA release control design).
 * Each store app has one policy; every change is classified by the shared direction
 * rules. A tightening change on an app whose policy carries an `approvalPolicy` becomes
 * a pre-approval under that (current) policy and is applied by `applyApproved`; any
 * other change applies at once, and a relaxing one opens a post-hoc review. Applies use
 * optimistic concurrency on `revision`, so a stale approval never overwrites a newer edit.
 */
export class VersionPolicyService {
  constructor(private readonly deps: VersionPolicyServiceDeps) {}

  /** An iOS or Android app of the project, or throw. */
  private async requireStoreApp(workspaceId: string, projectId: string, appId: string) {
    const app = await this.deps.projects.requireApp(workspaceId, projectId, appId);
    if (!STORE_PLATFORMS.has(app.platform)) {
      throw new NotAStoreAppError(appId);
    }
    return app;
  }

  /** Write the next revision and its history row, and audit it. Undefined when the
   * revision moved since `expectedRevision` (nothing is written). */
  private async apply(
    workspaceId: string,
    change: PinnedChange,
    before: VersionPolicyRules | null,
    direction: PolicyDirection,
    actorUserId: string | null,
    approvalRequestId: string | null,
  ) {
    const { projectId, appId, expectedRevision, rules, reason } = change;
    const policy =
      expectedRevision === 0
        ? await this.deps.policies.insertFirst({ workspaceId, projectId, appId, ...rules })
        : await this.deps.policies.updateIfRevision(workspaceId, appId, expectedRevision, rules);
    if (policy === undefined) {
      return undefined;
    }
    const history = await this.deps.changes.insert({
      workspaceId,
      appId,
      before,
      after: rules,
      direction,
      actorUserId,
      approvalRequestId,
      reason,
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.versionPolicyChanged,
      subjectType: 'project_app',
      subjectId: appId,
      payload: { direction, revision: policy.revision, changeId: history.id, approvalRequestId },
    });
    return { policy, history };
  }

  /** The app's policy, or null when none was ever set. */
  async get(workspaceId: string, projectId: string, appId: string) {
    await this.requireStoreApp(workspaceId, projectId, appId);
    return (await this.deps.policies.find(workspaceId, appId)) ?? null;
  }

  /** The app's applied changes, newest first. */
  async listChanges(workspaceId: string, projectId: string, appId: string) {
    await this.requireStoreApp(workspaceId, projectId, appId);
    return await this.deps.changes.listByApp(workspaceId, appId);
  }

  /**
   * Request a change to the app's policy (the full new rules).
   * - Raising a version floor requires `storeLiveAttested` (the version is live on the store).
   * - A tightening change under an existing `approvalPolicy` supersedes older pending
   *   pre-approvals and opens a new one → `pending_approval`.
   * - Anything else applies now → `applied`; a relaxing change under an `approvalPolicy`
   *   also opens a post-hoc review.
   */
  async change(
    workspaceId: string,
    projectId: string,
    appId: string,
    actorUserId: string,
    input: VersionPolicyChangeInput,
  ) {
    await this.requireStoreApp(workspaceId, projectId, appId);
    const current = await this.deps.policies.find(workspaceId, appId);
    const before = current === undefined ? null : rulesOf(current);
    const direction = classifyPolicyChange(before, input.rules);
    if (isVersionFloorRaised(before, input.rules) && !input.storeLiveAttested) {
      throw new StoreLiveAttestationRequiredError();
    }
    const pinned: PinnedChange = {
      projectId,
      appId,
      expectedRevision: current?.revision ?? 0,
      rules: input.rules,
      reason: input.reason ?? null,
    };
    const gate = before?.approvalPolicy ?? null;

    if (direction === PolicyDirections.tighten && gate !== null) {
      await this.deps.approvals.supersedePending(workspaceId, OtaApprovalSubjects.versionPolicy, appId, actorUserId);
      const request = await this.deps.approvals.request(workspaceId, {
        kind: ApprovalKinds.preApproval,
        subjectType: OtaApprovalSubjects.versionPolicy,
        subjectId: appId,
        action: { ...pinned, storeLiveAttested: input.storeLiveAttested },
        requirements: gate,
        requestedByUserId: actorUserId,
      });
      return { outcome: VersionPolicyOutcomes.pendingApproval, policy: current ?? null, requestId: request.id };
    }

    const applied = await this.apply(workspaceId, pinned, before, direction, actorUserId, null);
    if (applied === undefined) {
      throw new VersionPolicyConflictError(appId);
    }
    if (direction === PolicyDirections.relax && gate !== null) {
      const review = await this.deps.approvals.request(workspaceId, {
        kind: ApprovalKinds.review,
        subjectType: OtaApprovalSubjects.versionPolicy,
        subjectId: appId,
        action: { changeId: applied.history.id, ...pinned },
        requirements: gate,
        requestedByUserId: actorUserId,
      });
      return { outcome: VersionPolicyOutcomes.applied, policy: applied.policy, requestId: review.id };
    }
    return { outcome: VersionPolicyOutcomes.applied, policy: applied.policy, requestId: null };
  }

  /**
   * The approval handler for `ota.version_policy`: apply the pinned rules of an approved
   * pre-approval, attributed to its requester and linked to the approval. If the policy
   * moved since the request was made, nothing is applied and the stale approval is
   * audited — the approvers approved a change against a policy that no longer exists.
   */
  async applyApproved(request: ApprovalRequestRow): Promise<void> {
    const change = pinnedChangeSchema.parse(request.action);
    const current = await this.deps.policies.find(request.workspaceId, change.appId);
    const before = current === undefined ? null : rulesOf(current);
    const applied =
      (current?.revision ?? 0) === change.expectedRevision
        ? await this.apply(
            request.workspaceId,
            change,
            before,
            classifyPolicyChange(before, change.rules),
            request.requestedByUserId,
            request.id,
          )
        : undefined;
    if (applied === undefined) {
      await this.deps.audit.record(request.workspaceId, {
        actorUserId: null,
        action: AuditActions.versionPolicyApprovalStale,
        subjectType: 'project_app',
        subjectId: change.appId,
        payload: { approvalRequestId: request.id, expectedRevision: change.expectedRevision },
      });
    }
  }
}
