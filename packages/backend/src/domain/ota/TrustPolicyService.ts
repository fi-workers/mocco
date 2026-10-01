import { AuditActions } from '@mocco/common/audit';

import { OidcTokenRejectedError } from '@backend/domain/integration/github/errors';
import { OidcExchangeDeniedError, TrustPolicyChannelError, TrustPolicyNotFoundError } from '@backend/domain/ota/errors';
import { matchingPolicy } from '@backend/domain/ota/trust-policy-match';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { GitHubOidcVerifier } from '@backend/domain/integration/github/oidc';
import type { OtaAppRepo, OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { OtaChannelRepo } from '@backend/domain/ota/repos/ota-channel.repo';
import type { TrustPolicyRepo, TrustPolicyRow } from '@backend/domain/ota/repos/trust-policy.repo';
import type { MintedSession, UploadService } from '@backend/domain/ota/UploadService';
import type { OtaTrustPolicyDto, OtaTrustPolicyInput } from '@mocco/common/ota-hosting';

export interface TrustPolicyServiceDeps {
  apps: OtaAppRepo;
  channels: OtaChannelRepo;
  policies: TrustPolicyRepo;
  uploads: Pick<UploadService, 'mintSession'>;
  verifier: Pick<GitHubOidcVerifier, 'verify'>;
  audit: AuditService;
}

export function toTrustPolicyDto(row: TrustPolicyRow): OtaTrustPolicyDto {
  return {
    id: row.id,
    appId: row.appId,
    provider: 'github',
    repositoryId: row.repositoryId.toString(),
    repository: row.repository,
    refPattern: row.refPattern,
    workflowRef: row.workflowRef,
    environment: row.environment,
    allowedChannels: row.allowedChannels,
    createdAt: row.createdAt,
  };
}

/**
 * Trusted publishing (OTA design §6.2): CI uploads without a stored Mocco secret. A
 * GitHub Actions job presents its OIDC token; Mocco verifies it and, if a policy for the
 * app matches its repository id, ref (and workflow, environment), mints a 15-minute
 * upload session limited to the policy's channels. Every refusal is audited and looks
 * the same to the caller.
 */
export class TrustPolicyService {
  constructor(private readonly deps: TrustPolicyServiceDeps) {}

  private async deny(app: OtaAppRow, reason: string, detail: Record<string, unknown> = {}): Promise<never> {
    console.warn(`[ota-oidc] denied: ${reason}`);
    await this.deps.audit.record(app.workspaceId, {
      actorUserId: null,
      action: AuditActions.otaUploadDenied,
      subjectType: 'ota_app',
      subjectId: app.id,
      payload: { reason, ...detail },
    });
    throw new OidcExchangeDeniedError();
  }

  async list(app: OtaAppRow): Promise<OtaTrustPolicyDto[]> {
    const rows = await this.deps.policies.listByApp(app.workspaceId, app.id);
    return rows.map(row => toTrustPolicyDto(row));
  }

  async create(app: OtaAppRow, actorUserId: string, input: OtaTrustPolicyInput): Promise<OtaTrustPolicyDto> {
    const channels = await this.deps.channels.listByApp(app.workspaceId, app.id);
    const invalid = input.allowedChannels.find(
      name => channels.find(channel => channel.name === name)?.isProtected !== false,
    );
    if (invalid !== undefined) {
      throw new TrustPolicyChannelError(invalid);
    }
    const row = await this.deps.policies.insert({
      workspaceId: app.workspaceId,
      appId: app.id,
      repositoryId: BigInt(input.repositoryId),
      repository: input.repository,
      refPattern: input.refPattern,
      workflowRef: input.workflowRef,
      environment: input.environment,
      allowedChannels: input.allowedChannels,
      createdByUserId: actorUserId,
    });
    await this.deps.audit.record(app.workspaceId, {
      actorUserId,
      action: AuditActions.otaTrustPolicyCreated,
      subjectType: 'ota_app',
      subjectId: app.id,
      payload: { policy: { ...toTrustPolicyDto(row), createdAt: undefined } },
    });
    return toTrustPolicyDto(row);
  }

  async delete(app: OtaAppRow, actorUserId: string, policyId: string): Promise<void> {
    let row: TrustPolicyRow;
    try {
      row = await this.deps.policies.getInApp(app.workspaceId, app.id, policyId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new TrustPolicyNotFoundError(policyId, { cause: error });
      }
      throw error;
    }
    await this.deps.policies.delete(row.id);
    await this.deps.audit.record(app.workspaceId, {
      actorUserId,
      action: AuditActions.otaTrustPolicyDeleted,
      subjectType: 'ota_app',
      subjectId: app.id,
      payload: { policyId: row.id, repository: row.repository, refPattern: row.refPattern },
    });
  }

  /** Exchange a GitHub Actions OIDC token for an upload session, or OidcExchangeDeniedError. */
  async exchange(appId: string, token: string): Promise<MintedSession> {
    const app = await this.deps.apps.findById(appId);
    if (app === undefined) {
      // No workspace to attribute an audit entry to.
      console.warn('[ota-oidc] denied: unknown app');
      throw new OidcExchangeDeniedError();
    }
    let claims: Awaited<ReturnType<GitHubOidcVerifier['verify']>>;
    try {
      claims = await this.deps.verifier.verify(token);
    } catch (error) {
      if (error instanceof OidcTokenRejectedError) {
        return await this.deny(app, error.message);
      }
      throw error;
    }
    const subject = { repository: claims.repository, repositoryId: claims.repository_id, ref: claims.ref };
    const policies = await this.deps.policies.listForRepository(app.id, BigInt(claims.repository_id));
    const policy = matchingPolicy(policies, claims);
    if (policy === undefined) {
      return await this.deny(app, 'no trust policy matches', { ...subject, workflowRef: claims.job_workflow_ref });
    }
    return await this.deps.uploads.mintSession(app, {
      principal: `github:repo:${claims.repository_id}:ref:${claims.ref}`,
      trustPolicyId: policy.id,
      allowedChannels: policy.allowedChannels,
    });
  }
}
