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

/** What a channel head serves now — wire shape for the console. */
export const otaChannelHeadSchema = z.object({
  channelId: z.uuid(),
  platform: otaPlatformSchema,
  runtimeVersion: z.string(),
  releaseId: z.uuid().nullable(),
  updatedAt: z.date(),
});
export type OtaChannelHeadDto = z.infer<typeof otaChannelHeadSchema>;

/** `POST /v1/ota/apps/:appId/releases/:releaseId/promotions`. */
export const promotionRequestSchema = z.object({
  channel: z.string().regex(CHANNEL_NAME_PATTERN),
  reason: z.string().max(500).nullable().default(null),
});
export type PromotionRequest = z.infer<typeof promotionRequestSchema>;

/** The result of a promotion: the platforms whose heads now serve the release. */
export interface PromotionResult {
  channel: string;
  releaseId: string;
  platforms: OtaPlatform[];
  /** False when the channel already served this release (nothing changed). */
  changed: boolean;
}

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
