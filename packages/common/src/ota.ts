import { z } from 'zod';

import { gateRequirementsSchema } from './governance';

/**
 * OTA release control — version policy and native force update (phase 2 of the OTA
 * release control design). Pure functions and wire shapes shared by the backend (the
 * policy service and the public version-check endpoint) and, later, the React Native
 * client package.
 */

/** Approval subject types owned by the OTA domain (see ApprovalService). */
export const OtaApprovalSubjects = {
  versionPolicy: 'ota.version_policy',
} as const;

/** A store app version: 1–4 dot-separated non-negative integers (`2`, `2.3`, `2.3.1`, `2.3.1.4`). */
export const VERSION_PATTERN = /^\d{1,9}(?:\.\d{1,9}){0,3}$/;
export const versionSchema = z.string().regex(VERSION_PATTERN);

/** Compare two valid versions segment by segment; missing segments count as 0
 * (`2.3` equals `2.3.0`). Returns a negative number, 0, or a positive number. */
// sonarjs/null-dereference is a false positive: `version` is a non-nullable string
// (callers pass schema-validated versions).
// eslint-disable-next-line sonarjs/null-dereference
const segmentsOf = (version: string): number[] => version.split('.').map(Number);

export function compareVersions(left: string, right: string): number {
  const a = segmentsOf(left);
  const b = segmentsOf(right);
  const length = Math.max(a.length, b.length);
  const differing = Array.from({ length }, (_, index) => (a[index] ?? 0) - (b[index] ?? 0)).find(diff => diff !== 0);
  return differing ?? 0;
}

/** What the app should do for a given installed version. */
export const VersionStatuses = {
  ok: 'ok',
  soft: 'soft',
  hard: 'hard',
} as const;
export type VersionStatus = (typeof VersionStatuses)[keyof typeof VersionStatuses];
export const versionStatusSchema = z.enum(Object.values(VersionStatuses) as [VersionStatus, ...VersionStatus[]]);

/** The locale-keyed prompt copy. An `en` entry is required so every locale has a fallback. */
export const versionMessageSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(1000),
  action: z.string().min(1).max(40),
});
export type VersionMessage = z.infer<typeof versionMessageSchema>;
export const versionMessagesSchema = z
  .record(z.string().min(2).max(35), versionMessageSchema)
  .refine(messages => 'en' in messages, { message: 'An en message is required' });

/** The editable rules of an app's version policy. */
export const versionPolicyRulesSchema = z
  .object({
    minSupportedVersion: versionSchema.nullable(),
    recommendedVersion: versionSchema.nullable(),
    blockedVersions: z.array(versionSchema).max(100),
    messages: versionMessagesSchema,
    storeUrl: z.url().nullable(),
    softPromptIntervalHours: z.number().int().min(1).max(8760),
    /** Requirements for tightening changes; null = tightening applies without approval. */
    approvalPolicy: gateRequirementsSchema.nullable(),
  })
  .refine(
    rules =>
      rules.minSupportedVersion === null ||
      rules.recommendedVersion === null ||
      compareVersions(rules.recommendedVersion, rules.minSupportedVersion) >= 0,
    { message: 'The recommended version must not be below the minimum supported version' },
  );
export type VersionPolicyRules = z.infer<typeof versionPolicyRulesSchema>;

/** Decide the status of an installed version: blocked or below the minimum → hard;
 * below the recommended → soft; otherwise ok. */
export function evaluateVersionPolicy(
  rules: Pick<VersionPolicyRules, 'minSupportedVersion' | 'recommendedVersion' | 'blockedVersions'>,
  version: string,
): VersionStatus {
  if (rules.blockedVersions.some(blocked => compareVersions(blocked, version) === 0)) {
    return VersionStatuses.hard;
  }
  if (rules.minSupportedVersion !== null && compareVersions(version, rules.minSupportedVersion) < 0) {
    return VersionStatuses.hard;
  }
  if (rules.recommendedVersion !== null && compareVersions(version, rules.recommendedVersion) < 0) {
    return VersionStatuses.soft;
  }
  return VersionStatuses.ok;
}

/** How a policy change moves risk (the direction rules of the OTA release control design). */
export const PolicyDirections = {
  tighten: 'tighten',
  relax: 'relax',
  none: 'none',
} as const;
export type PolicyDirection = (typeof PolicyDirections)[keyof typeof PolicyDirections];
export const policyDirectionSchema = z.enum(Object.values(PolicyDirections) as [PolicyDirection, ...PolicyDirection[]]);

/** Raising (or newly setting) a version floor tightens; lowering or clearing it relaxes. */
function floorMove(before: string | null, after: string | null): PolicyDirection {
  if (before === after) {
    return PolicyDirections.none;
  }
  if (after === null) {
    return PolicyDirections.relax;
  }
  if (before === null) {
    return PolicyDirections.tighten;
  }
  const diff = compareVersions(after, before);
  if (diff === 0) {
    return PolicyDirections.none;
  }
  return diff > 0 ? PolicyDirections.tighten : PolicyDirections.relax;
}

/**
 * Classify a change. Any tightening component makes the whole change `tighten` (it is
 * gated); otherwise any relaxing component makes it `relax` (applied at once, reviewed
 * after); copy and prompt-interval edits alone are `none`. A changed store URL is
 * tightening (it could send every user to a different link), and so is any change to
 * an existing approval policy (weakening a policy is gated under the current one).
 */
export function classifyPolicyChange(before: VersionPolicyRules | null, after: VersionPolicyRules): PolicyDirection {
  const previous: Pick<
    VersionPolicyRules,
    'minSupportedVersion' | 'recommendedVersion' | 'blockedVersions' | 'storeUrl' | 'approvalPolicy'
  > = before ?? {
    minSupportedVersion: null,
    recommendedVersion: null,
    blockedVersions: [],
    storeUrl: null,
    approvalPolicy: null,
  };
  const moves = new Set([
    floorMove(previous.minSupportedVersion, after.minSupportedVersion),
    floorMove(previous.recommendedVersion, after.recommendedVersion),
  ]);
  const hasBlockedAdded = after.blockedVersions.some(version => !previous.blockedVersions.includes(version));
  const hasBlockedRemoved = previous.blockedVersions.some(version => !after.blockedVersions.includes(version));
  const isStoreUrlChanged = previous.storeUrl !== after.storeUrl;
  const isApprovalPolicyChanged =
    previous.approvalPolicy !== null &&
    JSON.stringify(previous.approvalPolicy) !== JSON.stringify(after.approvalPolicy);

  if (moves.has(PolicyDirections.tighten) || hasBlockedAdded || isStoreUrlChanged || isApprovalPolicyChanged) {
    return PolicyDirections.tighten;
  }
  if (moves.has(PolicyDirections.relax) || hasBlockedRemoved) {
    return PolicyDirections.relax;
  }
  return PolicyDirections.none;
}

/** Whether a change raises a version floor to a version that must already be live on the store. */
export function isVersionFloorRaised(before: VersionPolicyRules | null, after: VersionPolicyRules): boolean {
  return (
    floorMove(before?.minSupportedVersion ?? null, after.minSupportedVersion) === PolicyDirections.tighten ||
    floorMove(before?.recommendedVersion ?? null, after.recommendedVersion) === PolicyDirections.tighten
  );
}

/** An app's stored version policy — wire shape. */
export const versionPolicySchema = z.object({
  appId: z.uuid(),
  projectId: z.uuid(),
  minSupportedVersion: z.string().nullable(),
  recommendedVersion: z.string().nullable(),
  blockedVersions: z.array(z.string()),
  messages: z.record(z.string(), versionMessageSchema),
  storeUrl: z.string().nullable(),
  softPromptIntervalHours: z.number().int(),
  approvalPolicy: gateRequirementsSchema.nullable(),
  revision: z.number().int(),
  updatedAt: z.date(),
});
export type VersionPolicyDto = z.infer<typeof versionPolicySchema>;

/** One applied change — wire shape. */
export const versionPolicyChangeSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
  direction: policyDirectionSchema,
  actorUserId: z.uuid().nullable(),
  approvalRequestId: z.uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: z.date(),
});
export type VersionPolicyChangeDto = z.infer<typeof versionPolicyChangeSchema>;

/** Change input: the full new rules, an optional reason, and the store-live attestation
 * (required when a version floor is raised). */
export const versionPolicyChangeInputSchema = z.object({
  rules: versionPolicyRulesSchema,
  reason: z.string().min(1).max(500).optional(),
  storeLiveAttested: z.boolean().default(false),
});
export type VersionPolicyChangeInput = z.infer<typeof versionPolicyChangeInputSchema>;

/** The result of a change request. */
export const VersionPolicyOutcomes = {
  applied: 'applied',
  pendingApproval: 'pending_approval',
} as const;
export type VersionPolicyOutcome = (typeof VersionPolicyOutcomes)[keyof typeof VersionPolicyOutcomes];

/** The public version-check response. `revision` 0 means the app has no policy (or is
 * unknown): the answer is always `ok` then, so a misconfigured app never locks users out. */
export const versionCheckResponseSchema = z.object({
  status: versionStatusSchema,
  minSupportedVersion: z.string().nullable(),
  recommendedVersion: z.string().nullable(),
  message: versionMessageSchema.nullable(),
  storeUrl: z.string().nullable(),
  promptIntervalHours: z.number().int(),
  revision: z.number().int(),
});
export type VersionCheckResponse = z.infer<typeof versionCheckResponseSchema>;

/** Pick the prompt copy for a BCP 47 locale: exact tag, then its language, then `en`. */
export function pickVersionMessage(
  messages: Record<string, VersionMessage>,
  locale: string | undefined,
): VersionMessage | null {
  const language = locale?.split('-', 1)[0];
  const key = [locale, language, 'en'].find(
    (candidate): candidate is string => candidate !== undefined && Object.hasOwn(messages, candidate),
  );
  return key === undefined ? null : (messages[key] ?? null);
}
