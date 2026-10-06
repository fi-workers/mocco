// Production composition root for the OTA domain. Lazy so builds don't need env at
// import. Binding the version-policy approval handler here keeps the dependency one-way
// (ota → governance): governance never imports a product domain.
import { OtaApprovalSubjects } from '@mocco/common/ota';
import { OtaHostingApprovalSubjects } from '@mocco/common/ota-hosting';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';

import { getAudit } from '@backend/domain/audit/instance';
import { getEventBus } from '@backend/domain/events/instance';
import { resolveBaseOrigin, schemeFor } from '@backend/domain/execution/endpoints';
import { getGovernance } from '@backend/domain/governance/instance';
import { GitHubOidcVerifier } from '@backend/domain/integration/github/oidc';
import { getJobQueue } from '@backend/domain/jobs/instance';
import { ExternalCredentialService } from '@backend/domain/ota/ExternalCredentialService';
import { OtaChannelService } from '@backend/domain/ota/OtaChannelService';
import { OtaHostingService } from '@backend/domain/ota/OtaHostingService';
import { OtaMetricsService } from '@backend/domain/ota/OtaMetricsService';
import { ChannelHeadRepo } from '@backend/domain/ota/repos/channel-head.repo';
import { OtaAppRepo } from '@backend/domain/ota/repos/ota-app.repo';
import { OtaAssetRepo } from '@backend/domain/ota/repos/ota-asset.repo';
import { OtaChannelRepo } from '@backend/domain/ota/repos/ota-channel.repo';
import { OtaExternalCredentialRepo } from '@backend/domain/ota/repos/ota-external-credential.repo';
import { OtaMetricsRepo } from '@backend/domain/ota/repos/ota-metrics.repo';
import { OtaReleaseRepo } from '@backend/domain/ota/repos/ota-release.repo';
import { SigningCertificateRepo } from '@backend/domain/ota/repos/signing-certificate.repo';
import { TrustPolicyRepo } from '@backend/domain/ota/repos/trust-policy.repo';
import { UploadSessionRepo } from '@backend/domain/ota/repos/upload-session.repo';
import { VersionPolicyChangeRepo } from '@backend/domain/ota/repos/version-policy-change.repo';
import { VersionPolicyRepo } from '@backend/domain/ota/repos/version-policy.repo';
import { ChannelStateCache } from '@backend/domain/ota/serving/state-cache';
import { SigningService } from '@backend/domain/ota/SigningService';
import { TrustPolicyService } from '@backend/domain/ota/TrustPolicyService';
import { UpdateCheckService } from '@backend/domain/ota/UpdateCheckService';
import { UploadService } from '@backend/domain/ota/UploadService';
import { VersionCheckService } from '@backend/domain/ota/VersionCheckService';
import { VersionPolicyService } from '@backend/domain/ota/VersionPolicyService';
import { getProjectDomain } from '@backend/domain/project/instance';
import { getStorageDomain } from '@backend/domain/storage/instance';
import { getEnv } from '@backend/infra/config/env';
import { getSecretBox } from '@backend/infra/crypto/instance';
import { getDb } from '@backend/infra/db/client';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { StorageService } from '@backend/domain/storage/StorageService';
import type { Env } from '@backend/infra/config/env';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
import type { Db } from '@backend/infra/db/types';
import type { JWTVerifyGetKey } from 'jose';

export interface OtaDomain {
  versionPolicies: VersionPolicyService;
  versionChecks: VersionCheckService;
  externalCredentials: ExternalCredentialService;
  otaHosting: OtaHostingService;
  otaSigning: SigningService;
  otaUploads: UploadService;
  otaChannels: OtaChannelService;
  otaUpdateChecks: UpdateCheckService;
  otaTrustPolicies: TrustPolicyService;
  otaMetrics: OtaMetricsService;
}

/** The production queue, resolved on first enqueue (tests that never upload need no env). */
const lazyQueue: JobQueue = {
  enqueue: async (job, payload, options) => await getJobQueue().enqueue(job, payload, options),
  kick: jobId => {
    getJobQueue().kick(jobId);
  },
};

/** Where device-facing OTA URLs live: the public API host when PUBLIC_API_DOMAIN is set
 * (`https://api.mocco.club/v1`), else the app origin's `/api/ext/v1`. */
export function publicApiBaseFromEnv(env: Env): string {
  if (env.PUBLIC_API_DOMAIN !== undefined) {
    return `${schemeFor(env.PUBLIC_API_DOMAIN)}://${env.PUBLIC_API_DOMAIN}/v1`;
  }
  return `${resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL })}/api/ext/v1`;
}

/** Build the OTA services over a db and register their approval handlers on `approvals`.
 * The production root below binds it once; tests call it with a pglite db. */
export function createOtaDomain(
  db: Db,
  deps: {
    projects: ProjectService;
    approvals: ApprovalService;
    audit: AuditService;
    /** Lazy SecretBox; defaults to the env-configured one. */
    secretBox?: () => SecretBox;
    /** The base of device-facing URLs (`publicApiBaseFromEnv` in production). */
    publicApiBase: string;
    /** Where uploaded bundles go; undefined refuses uploads. */
    storage?: StorageService;
    queue?: JobQueue;
    /** GitHub's OIDC keys; tests pass a local key set. */
    oidcKeys?: JWTVerifyGetKey;
    /** Where promotion requests and decisions are published; omitted in most tests. */
    events?: EventPublisher;
    /** The app origin, for links in notification messages. */
    appOrigin?: string;
    /** Keeps metrics writes alive after a response (Vercel `waitUntil`). */
    waitUntil?: (promise: Promise<unknown>) => void;
  },
): OtaDomain {
  const policies = new VersionPolicyRepo(db);
  const {
    secretBox = getSecretBox,
    publicApiBase,
    storage,
    queue = lazyQueue,
    oidcKeys,
    events,
    appOrigin,
    waitUntil,
    ...services
  } = deps;
  const versionPolicies = new VersionPolicyService({
    policies,
    changes: new VersionPolicyChangeRepo(db),
    ...services,
  });
  deps.approvals.registerHandler(OtaApprovalSubjects.versionPolicy, async request => {
    await versionPolicies.applyApproved(request);
  });
  deps.approvals.registerLabeler(
    [OtaApprovalSubjects.versionPolicy],
    async (workspaceId, requests) => await versionPolicies.labelApprovalSubjects(workspaceId, requests),
  );
  const hosting = new OtaHostingService({
    apps: new OtaAppRepo(db),
    channels: new OtaChannelRepo(db),
    projects: services.projects,
    approvals: services.approvals,
    audit: services.audit,
    publicApiBase,
  });
  deps.approvals.registerHandler(OtaHostingApprovalSubjects.channelPolicy, async request => {
    await hosting.applyApprovedPolicy(request);
  });
  deps.approvals.registerLabeler(
    [OtaHostingApprovalSubjects.channelPolicy, OtaHostingApprovalSubjects.channelChange],
    async (workspaceId, requests) => await hosting.labelApprovalSubjects(workspaceId, requests),
  );
  const signing = new SigningService({ certificates: new SigningCertificateRepo(db), audit: services.audit });
  // One cache per domain instance: promotions here invalidate what the manifest endpoint serves.
  const cache = new ChannelStateCache();
  const releases = new OtaReleaseRepo(db);
  const heads = new ChannelHeadRepo(db);
  const assets = new OtaAssetRepo(db);
  const metrics = new OtaMetricsService({
    apps: new OtaAppRepo(db),
    metrics: new OtaMetricsRepo(db),
    releases,
    ...(waitUntil !== undefined && { waitUntil }),
    ...(events !== undefined && { events }),
    ...(appOrigin !== undefined && { appOrigin }),
  });
  const channelService = new OtaChannelService({
    apps: new OtaAppRepo(db),
    channels: new OtaChannelRepo(db),
    releases,
    heads,
    assets,
    approvals: services.approvals,
    audit: services.audit,
    cache,
    ...(events !== undefined && { events }),
    ...(appOrigin !== undefined && { appOrigin }),
  });
  deps.approvals.registerHandler(OtaHostingApprovalSubjects.channelChange, async request => {
    await channelService.applyApproved(request);
  });
  deps.approvals.onRejected(OtaHostingApprovalSubjects.channelChange, async request => {
    await channelService.notifyRejected(request);
  });
  const uploads = new UploadService({
    apps: new OtaAppRepo(db),
    sessions: new UploadSessionRepo(db),
    releases,
    assets,
    signing,
    storage,
    queue,
    audit: services.audit,
  });
  return {
    versionPolicies,
    versionChecks: new VersionCheckService({ policies }),
    externalCredentials: new ExternalCredentialService({
      credentials: new OtaExternalCredentialRepo(db),
      projects: services.projects,
      audit: services.audit,
      secretBox,
    }),
    otaHosting: hosting,
    otaSigning: signing,
    otaUploads: uploads,
    otaChannels: channelService,
    otaUpdateChecks: new UpdateCheckService({ heads, assets, storage, cache, metrics }),
    otaMetrics: metrics,
    otaTrustPolicies: new TrustPolicyService({
      apps: new OtaAppRepo(db),
      channels: new OtaChannelRepo(db),
      policies: new TrustPolicyRepo(db),
      uploads,
      // Jobs request their OIDC token for Mocco's public API origin.
      verifier: new GitHubOidcVerifier({
        audience: new URL(publicApiBase).origin,
        ...(oidcKeys !== undefined && { keys: oidcKeys }),
      }),
      audit: services.audit,
    }),
  };
}

const state: { ota?: OtaDomain } = {};

/** The OTA services. Always available (no external dependency to gate on). The tRPC
 * context builds this on every request, so the approval handler is registered before
 * any vote can reach it. */
export function getOtaDomain(): OtaDomain {
  state.ota ??= createOtaDomain(getDb(), {
    projects: getProjectDomain().projects,
    approvals: getGovernance().approvals,
    audit: getAudit().audit,
    publicApiBase: publicApiBaseFromEnv(getEnv()),
    storage: getStorageDomain()?.storage,
    events: getEventBus(),
    waitUntil: vercelWaitUntil,
    appOrigin: resolveBaseOrigin({ serviceDomain: getEnv().SERVICE_DOMAIN, vercelUrl: getEnv().VERCEL_URL }),
  });
  return state.ota;
}
