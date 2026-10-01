import { z } from 'zod';

import { gateRequirementsSchema } from './governance';

/**
 * Mocco-hosted OTA updates (phase 3 of the OTA release control design): the stock
 * `expo-updates` client fetches signed manifests from Mocco (ADR 0021), signed in the
 * customer's CI (ADR 0022). Constants and wire shapes shared by the backend and console.
 */

/** The device protocol an OTA app speaks. CodePush compatibility is phase 4. */
export const OtaProtocols = {
  expoUpdates: 'expo_updates',
} as const;
export type OtaProtocol = (typeof OtaProtocols)[keyof typeof OtaProtocols];

/** The platforms an update targets (`expo-platform`). */
export const OtaPlatforms = {
  ios: 'ios',
  android: 'android',
} as const;
export type OtaPlatform = (typeof OtaPlatforms)[keyof typeof OtaPlatforms];
export const otaPlatformSchema = z.enum([OtaPlatforms.ios, OtaPlatforms.android]);

/** expo-updates' default `codeSigningMetadata.keyid` (ADR 0021). */
export const DEFAULT_SIGNING_KEY_ID = 'root';
/** The only code-signing algorithm expo-updates supports. */
export const SIGNING_ALGORITHM = 'rsa-v1_5-sha256';

export const CertificateStatuses = {
  active: 'active',
  retired: 'retired',
} as const;
export type CertificateStatus = (typeof CertificateStatuses)[keyof typeof CertificateStatuses];

/** A release's lifecycle: uploaded bytes are re-hashed before it can be promoted. */
export const OtaReleaseStatuses = {
  uploading: 'uploading',
  verifying: 'verifying',
  ready: 'ready',
  failed: 'failed',
  disabled: 'disabled',
} as const;
export type OtaReleaseStatus = (typeof OtaReleaseStatuses)[keyof typeof OtaReleaseStatuses];

/** An update is the release's own (`original`) or a pre-signed copy of an older one for rollback. */
export const OtaUpdateKinds = {
  original: 'original',
  republish: 'republish',
} as const;
export type OtaUpdateKind = (typeof OtaUpdateKinds)[keyof typeof OtaUpdateKinds];

export const OtaDirectiveTypes = {
  noUpdateAvailable: 'noUpdateAvailable',
  rollBackToEmbedded: 'rollBackToEmbedded',
} as const;
export type OtaDirectiveType = (typeof OtaDirectiveTypes)[keyof typeof OtaDirectiveTypes];

/** What a deployment row records about a channel head change. */
export const OtaDeploymentKinds = {
  promote: 'promote',
  rollout: 'rollout',
  pause: 'pause',
  resume: 'resume',
  complete: 'complete',
  rollback: 'rollback',
  rollbackEmbedded: 'rollback_embedded',
  disable: 'disable',
} as const;
export type OtaDeploymentKind = (typeof OtaDeploymentKinds)[keyof typeof OtaDeploymentKinds];

/** Rollout shares are basis points: 10000 is every device. */
export const FULL_ROLLOUT_BP = 10_000;

/** Percent (0.01–100) to basis points. */
export const rolloutBpOf = (percent: number) => Math.min(FULL_ROLLOUT_BP, Math.max(1, Math.round(percent * 100)));

/** The actions that stop or undo a change — never gated, always audited. */
export const StopActions = {
  pause: OtaDeploymentKinds.pause,
  rollback: OtaDeploymentKinds.rollback,
  rollbackEmbedded: OtaDeploymentKinds.rollbackEmbedded,
} as const;
export type StopAction = (typeof StopActions)[keyof typeof StopActions];
export const stopActionSchema = z.enum([StopActions.pause, StopActions.rollback, StopActions.rollbackEmbedded]);

/** Approval subject types owned by OTA hosting (see ApprovalService). */
export const OtaHostingApprovalSubjects = {
  channelPolicy: 'ota.channel_policy',
  channelChange: 'ota.channel_change',
} as const;

/** A channel name: lowercase letters, digits and inner hyphens (it goes in `expo-channel-name`). */
export const CHANNEL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** A hosted OTA app — wire shape. */
export const otaAppSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectAppId: z.uuid(),
  protocol: z.enum([OtaProtocols.expoUpdates]),
  /** Fixed at creation: signed manifests point their asset URLs under it. */
  assetBaseUrl: z.string(),
  /** Where the app's `updates.url` points. */
  manifestUrl: z.string(),
  signingRequired: z.boolean(),
  createdAt: z.date(),
});
export type OtaAppDto = z.infer<typeof otaAppSchema>;

export const signingCertificateSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  keyid: z.string(),
  /** SHA-256 of the certificate's public key (hex), to recognise it. */
  spkiSha256: z.string(),
  subject: z.string(),
  notAfter: z.date(),
  status: z.enum([CertificateStatuses.active, CertificateStatuses.retired]),
  createdAt: z.date(),
});
export type SigningCertificateDto = z.infer<typeof signingCertificateSchema>;

export const signingCertificateInputSchema = z.object({
  /** PEM of the X.509 certificate the app embeds as `codeSigningCertificate`. */
  certificatePem: z.string().min(1).max(20_000),
  keyid: z
    .string()
    .regex(/^[\w.-]{1,64}$/)
    .default(DEFAULT_SIGNING_KEY_ID),
});
export type SigningCertificateInput = z.infer<typeof signingCertificateInputSchema>;

export const otaChannelSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  name: z.string(),
  isProtected: z.boolean(),
  /** Who must approve promotions; set exactly when the channel is protected. */
  policy: gateRequirementsSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type OtaChannelDto = z.infer<typeof otaChannelSchema>;

export const otaChannelCreateInputSchema = z.object({
  name: z.string().regex(CHANNEL_NAME_PATTERN),
  policy: gateRequirementsSchema.nullable().default(null),
});
export type OtaChannelCreateInput = z.infer<typeof otaChannelCreateInputSchema>;

/** The result of a policy change: applied now, or waiting for approval under the current policy. */
export const ChannelPolicyOutcomes = {
  applied: 'applied',
  pendingApproval: 'pending_approval',
} as const;
export type ChannelPolicyOutcome = (typeof ChannelPolicyOutcomes)[keyof typeof ChannelPolicyOutcomes];

/** The result of a channel change: applied now (an open channel, or a stop action), or
 * waiting for approval (a protected channel — `requestId` is the approval request). */
export const promotionResultSchema = z.object({
  channel: z.string(),
  releaseId: z.uuid().nullable(),
  kind: z.enum(Object.values(OtaDeploymentKinds) as [OtaDeploymentKind, ...OtaDeploymentKind[]]),
  platforms: z.array(otaPlatformSchema),
  /** True when heads changed now; false when nothing changed or approval is pending. */
  changed: z.boolean(),
  outcome: z.enum([ChannelPolicyOutcomes.applied, ChannelPolicyOutcomes.pendingApproval]),
  requestId: z.uuid().nullable(),
});
export type PromotionResult = z.infer<typeof promotionResultSchema>;

/** Base64url SHA-256 without padding — how expo-updates names and checks an asset. */
export const ASSET_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** How long an upload session (and its presigned PUTs) stays valid. */
export const UPLOAD_SESSION_TTL_SECONDS = 15 * 60;

/** Finalize accepts a manifest `createdAt` at most this far ahead of, or behind, the server clock. */
export const COMMIT_TIME_MAX_FUTURE_MS = 10 * 60 * 1000;
export const COMMIT_TIME_MAX_PAST_MS = 24 * 60 * 60 * 1000;

/** One asset of an Expo Updates manifest (protocol v1). */
export const expoManifestAssetSchema = z.object({
  hash: z.string().regex(ASSET_HASH_PATTERN),
  key: z.string().min(1).max(200),
  contentType: z.string().min(1).max(200),
  fileExtension: z.string().max(20).optional(),
  url: z.url(),
});
export type ExpoManifestAsset = z.infer<typeof expoManifestAssetSchema>;

/** An Expo Updates protocol v1 manifest, as the CLI signs it. */
export const expoManifestSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  runtimeVersion: z.string().min(1).max(100),
  launchAsset: expoManifestAssetSchema,
  assets: z.array(expoManifestAssetSchema).max(2000),
  metadata: z.record(z.string(), z.unknown()),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type ExpoManifest = z.infer<typeof expoManifestSchema>;

/** A `rollBackToEmbedded` directive body (protocol v1). */
export const rollBackToEmbeddedDirectiveSchema = z.object({
  type: z.literal(OtaDirectiveTypes.rollBackToEmbedded),
  parameters: z.object({ commitTime: z.iso.datetime({ offset: true }) }),
});

/** The detached signature of a signed body: what goes in `expo-signature`. */
export const bodySignatureSchema = z.object({
  sig: z.string().min(1).max(4096),
  keyid: z
    .string()
    .regex(/^[\w.-]{1,64}$/)
    .default(DEFAULT_SIGNING_KEY_ID),
});
export type BodySignature = z.infer<typeof bodySignatureSchema>;

/** `POST /v1/ota/uploads` — declare a release and its assets. */
export const uploadRequestSchema = z.object({
  runtimeVersion: z.string().min(1).max(100),
  platforms: z.array(otaPlatformSchema).min(1).max(2),
  assets: z
    .array(
      z.object({
        hash: z.string().regex(ASSET_HASH_PATTERN),
        size: z.number().int().positive(),
        contentType: z.string().min(1).max(200),
        ext: z.string().max(20).nullable().default(null),
      }),
    )
    .min(1)
    .max(4000),
  gitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable()
    .default(null),
  message: z.string().max(500).nullable().default(null),
  mandatory: z.boolean().default(false),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

/** The response: what to upload, and what to pre-sign for rollback. */
export interface UploadResponse {
  releaseId: string;
  assetBaseUrl: string;
  missing: { hash: string; putUrl: string; headers: Record<string, string> }[];
  /** The current head of each channel on this runtime: the CLI signs a republish of it
   * (newer `createdAt`), so rolling back from this release is instant. */
  rollbackTargets: { channel: string; platform: OtaPlatform; updateId: string; manifest: string }[];
}

const signedBodySchema = z.object({
  platform: otaPlatformSchema,
  /** The exact JSON string that was signed; stored and served byte for byte. */
  body: z.string().min(2).max(1_000_000),
  signature: bodySignatureSchema.nullable().default(null),
});

/** `POST /v1/ota/uploads/:releaseId/finalize`. */
export const finalizeRequestSchema = z.object({
  updates: z.array(signedBodySchema).min(1).max(2),
  /** Pre-signed copies of `rollbackTargets`, valid for devices on this release's update. */
  republishes: z
    .array(signedBodySchema.extend({ targetUpdateId: z.uuid() }))
    .max(50)
    .default([]),
  /** Pre-signed `rollBackToEmbedded` directives, one per platform. */
  directives: z.array(signedBodySchema).max(2).default([]),
});
export type FinalizeRequest = z.infer<typeof finalizeRequestSchema>;

export const otaReleaseSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  runtimeVersion: z.string(),
  status: z.enum([
    OtaReleaseStatuses.uploading,
    OtaReleaseStatuses.verifying,
    OtaReleaseStatuses.ready,
    OtaReleaseStatuses.failed,
    OtaReleaseStatuses.disabled,
  ]),
  message: z.string().nullable(),
  gitSha: z.string().nullable(),
  isMandatory: z.boolean(),
  uploadedByPrincipal: z.string().nullable(),
  platforms: z.array(otaPlatformSchema),
  /** What one device downloads: the largest platform update's assets. */
  downloadBytes: z.number(),
  createdAt: z.date(),
});
export type OtaReleaseDto = z.infer<typeof otaReleaseSchema>;

/** What a channel head serves and rolls out now — wire shape for the console. */
export const otaChannelHeadSchema = z.object({
  channelId: z.uuid(),
  platform: otaPlatformSchema,
  runtimeVersion: z.string(),
  /** The release whose content the active update serves (what devices outside a rollout get). */
  releaseId: z.uuid().nullable(),
  /** The active update is a rollback (a re-dated republish of `releaseId`). */
  isRolledBack: z.boolean(),
  /** The release rolling out to `rolloutBp` of devices, if any. */
  candidateReleaseId: z.uuid().nullable(),
  rolloutBp: z.number(),
  isPaused: z.boolean(),
  /** Serving a roll-back-to-embedded directive. */
  isServingEmbedded: z.boolean(),
  /** A pre-signed rollback exists for what it serves now. */
  canRollBack: z.boolean(),
  canRollBackToEmbedded: z.boolean(),
  updatedAt: z.date(),
});
export type OtaChannelHeadDto = z.infer<typeof otaChannelHeadSchema>;

/** `POST /v1/ota/apps/:appId/channels/:channel/{pause,rollback,rollback-to-embedded}`. */
export const stopRequestSchema = z.object({
  runtimeVersion: z.string().min(1).max(100).nullable().default(null),
  /** Only this platform's head (rollbacks); both when null. */
  platform: otaPlatformSchema.nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
});

/** `POST /v1/ota/apps/:appId/releases/:releaseId/promotions`. */
export const promotionRequestSchema = z.object({
  channel: z.string().regex(CHANNEL_NAME_PATTERN),
  reason: z.string().max(500).nullable().default(null),
  /** Below 100 starts a staged rollout of the release to that share of devices. */
  rolloutPercent: z.number().min(0.01).max(100).default(100),
});
export type PromotionRequest = z.infer<typeof promotionRequestSchema>;

/** A ref pattern: an exact ref, or `*` as a wildcard within it (`refs/tags/v*`). */
export const REF_PATTERN = /^refs\/[\w./*-]{1,200}$/;

/** Who may publish without a stored key: a GitHub repository (by numeric id) and ref. */
export const otaTrustPolicySchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  provider: z.literal('github'),
  repositoryId: z.string(),
  repository: z.string(),
  refPattern: z.string(),
  workflowRef: z.string().nullable(),
  environment: z.string().nullable(),
  /** Unprotected channels a session from this policy may promote to. */
  allowedChannels: z.array(z.string()),
  createdAt: z.date(),
});
export type OtaTrustPolicyDto = z.infer<typeof otaTrustPolicySchema>;

export const otaTrustPolicyInputSchema = z.object({
  repositoryId: z.string().regex(/^\d{1,20}$/),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  refPattern: z.string().regex(REF_PATTERN).default('refs/heads/main'),
  workflowRef: z.string().min(1).max(300).nullable().default(null),
  environment: z.string().min(1).max(100).nullable().default(null),
  allowedChannels: z.array(z.string().regex(CHANNEL_NAME_PATTERN)).max(20).default([]),
});
export type OtaTrustPolicyInput = z.infer<typeof otaTrustPolicyInputSchema>;

/** `POST /v1/ota/auth/oidc`. */
export const oidcExchangeRequestSchema = z.object({
  appId: z.uuid(),
  token: z.string().min(1).max(10_000),
});

/** The broker provider id a gated Mocco run step names to get an upload session. */
export const MOCCO_OTA_CREDENTIAL_PROVIDER = 'mocco-ota';

/** What a promotion would change on a channel, per platform (for the approval card). */
export const promotionPreviewSchema = z.object({
  channel: z.string(),
  releaseId: z.uuid(),
  platforms: z.array(
    z.object({
      platform: otaPlatformSchema,
      replacesUpdateId: z.uuid().nullable(),
      /** Assets devices on the channel would download that they don't have. */
      newAssets: z.number(),
      newBytes: z.number(),
      removedAssets: z.number(),
    }),
  ),
});
export type PromotionPreview = z.infer<typeof promotionPreviewSchema>;

/** What the app reports from devices (`@mocco/react-native-ota`). */
export const OtaClientEventTypes = {
  launched: 'launched',
  emergencyLaunch: 'emergency_launch',
  error: 'error',
} as const;
export type OtaClientEventType = (typeof OtaClientEventTypes)[keyof typeof OtaClientEventTypes];

/** `POST /v1/ota/apps/:appId/events`: up to 50 events from one device, at most 16 KB. */
export const OTA_EVENTS_MAX_BYTES = 16 * 1024;
export const clientEventsRequestSchema = z.object({
  /** The device's `EAS-Client-ID`; hashed with the app's pepper, never stored. */
  clientId: z.string().min(8).max(200),
  platform: otaPlatformSchema,
  events: z
    .array(
      z.object({
        type: z.enum([OtaClientEventTypes.launched, OtaClientEventTypes.emergencyLaunch, OtaClientEventTypes.error]),
        updateId: z.uuid().nullable(),
        occurredAt: z.iso.datetime({ offset: true }).optional(),
        /** Bounded detail, e.g. an error message. */
        detail: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type ClientEventsRequest = z.infer<typeof clientEventsRequestSchema>;

/** How many devices run a release, now and per day. */
export const releaseAdoptionSchema = z.object({
  releaseId: z.uuid(),
  /** Devices whose last check (within 24 hours) reported this release's update. */
  activeDevices: z.number(),
  emergencyLaunches: z.number(),
  daily: z.array(
    z.object({ day: z.string(), activeDevices: z.number(), newDevices: z.number(), emergencyLaunches: z.number() }),
  ),
});
export type ReleaseAdoptionDto = z.infer<typeof releaseAdoptionSchema>;

/** A release's emergency-launch rate at or over this (with enough launches) alerts. */
export const EMERGENCY_LAUNCH_ALERT = { minLaunches: 5, rate: 0.05 } as const;

/** One entry of a channel's history (`mocco_ota_deployments`) — wire shape. */
export const otaDeploymentSchema = z.object({
  id: z.uuid(),
  kind: z.enum(Object.values(OtaDeploymentKinds) as [OtaDeploymentKind, ...OtaDeploymentKind[]]),
  releaseId: z.uuid().nullable(),
  releaseMessage: z.string().nullable(),
  gitSha: z.string().nullable(),
  fromBp: z.number().nullable(),
  toBp: z.number().nullable(),
  actorUserId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  actorPrincipal: z.string().nullable(),
  approvalRequestId: z.uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: z.date(),
});
export type OtaDeploymentDto = z.infer<typeof otaDeploymentSchema>;

/** How far back a channel timeline reaches (`?range=` on the channel page). */
export const TimelineRanges = { week: '7d', month: '30d', all: 'all' } as const;
export type TimelineRange = (typeof TimelineRanges)[keyof typeof TimelineRanges];
export const timelineRangeSchema = z.enum([TimelineRanges.week, TimelineRanges.month, TimelineRanges.all]);

/** A release with its updates, where they're served, and its approval history. */
export const otaReleaseDetailSchema = z.object({
  release: otaReleaseSchema,
  updates: z.array(
    z.object({
      id: z.uuid(),
      platform: otaPlatformSchema,
      kind: z.enum([OtaUpdateKinds.original, OtaUpdateKinds.republish]),
      commitTime: z.date(),
      totalBytes: z.number(),
      keyid: z.string().nullable(),
      /** For a republish: the update it lets devices roll back from. */
      supersedesUpdateId: z.uuid().nullable(),
    }),
  ),
  servedOn: z.array(
    z.object({
      channelId: z.uuid(),
      channel: z.string(),
      platform: otaPlatformSchema,
      runtimeVersion: z.string(),
      /** active: everyone outside a rollout; candidate: the rollout share. */
      role: z.enum(['active', 'candidate']),
      rolloutBp: z.number(),
    }),
  ),
  approvals: z.array(
    z.object({
      requestId: z.uuid(),
      channelId: z.uuid(),
      kind: z.string(),
      state: z.string(),
      requestedByUserId: z.uuid().nullable(),
      createdAt: z.date(),
    }),
  ),
});
export type OtaReleaseDetailDto = z.infer<typeof otaReleaseDetailSchema>;

/** Which runtime versions depend on a certificate: updates it verified, per runtime. */
export const certificateUsageSchema = z.object({
  certificateId: z.uuid(),
  runtimes: z.array(z.object({ runtimeVersion: z.string(), updates: z.number(), lastCommitTime: z.date() })),
});
export type CertificateUsageDto = z.infer<typeof certificateUsageSchema>;
