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
