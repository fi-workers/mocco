// Plain-text descriptions of version policies for the Force update screen: the approval
// policy in words, the rules a history row or approval request pins, and a line-per-field
// diff between two rule sets.
import { PolicyDirections, versionPolicyRulesSchema } from '@mocco/common/ota';
import { z } from 'zod';

import type { GateRequirements } from '@mocco/common/governance';
import type { PolicyDirection, VersionPolicyDto, VersionPolicyRules } from '@mocco/common/ota';

export const directionLabels: Record<PolicyDirection, string> = {
  [PolicyDirections.tighten]: 'Tightens',
  [PolicyDirections.relax]: 'Relaxes',
  [PolicyDirections.none]: 'No risk change',
};

/** "2 × mobile-release and 1 × qa · not the requester · reason required". */
export function describeApprovalPolicy(policy: GateRequirements | null): string {
  if (policy === null) {
    return 'None — tightening changes apply at once';
  }
  const roles = policy.resume.map(entry => `${entry.count} × ${entry.role}`).join(' and ');
  const flags = [policy.prevent_self && 'not the requester', policy.reason_required && 'reason required'].filter(
    (flag): flag is string => typeof flag === 'string',
  );
  return [roles, ...flags].join(' · ');
}

/** The editable rules of a stored policy (the shape a change submits). */
export function rulesOfPolicy(policy: VersionPolicyDto): VersionPolicyRules {
  return {
    minSupportedVersion: policy.minSupportedVersion,
    recommendedVersion: policy.recommendedVersion,
    blockedVersions: policy.blockedVersions,
    messages: policy.messages,
    storeUrl: policy.storeUrl,
    softPromptIntervalHours: policy.softPromptIntervalHours,
    approvalPolicy: policy.approvalPolicy,
  };
}

/** Stored rules (a history row's `before`/`after`, a request's pinned `rules`), or null
 * when the shape is not a rule set. */
export function parseRules(value: unknown): VersionPolicyRules | null {
  const parsed = versionPolicyRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The fields a version-policy approval request pins in its `action`. */
const pinnedActionSchema = z.object({
  rules: z.unknown(),
  reason: z.string().nullable().optional(),
  storeLiveAttested: z.boolean().optional(),
  /** Set on a post-hoc review: the history row of the change it reviews. */
  changeId: z.uuid().optional(),
});

export interface PinnedAction {
  rules: VersionPolicyRules | null;
  reason: string | null;
  isStoreLiveAttested: boolean;
  changeId: string | null;
}

/** A request's pinned fields; an unrecognized action reads as empty. */
export function parsePinnedAction(action: Record<string, unknown>): PinnedAction {
  const parsed = pinnedActionSchema.safeParse(action);
  if (!parsed.success) {
    return { rules: null, reason: null, isStoreLiveAttested: false, changeId: null };
  }
  return {
    rules: parseRules(parsed.data.rules),
    reason: parsed.data.reason ?? null,
    isStoreLiveAttested: parsed.data.storeLiveAttested === true,
    changeId: parsed.data.changeId ?? null,
  };
}

const EMPTY = '—';
const orEmpty = (value: string | null) => value ?? EMPTY;
const list = (values: readonly string[]) => (values.length === 0 ? EMPTY : values.join(', '));

interface Field {
  label: string;
  show: (rules: VersionPolicyRules) => string;
}

const FIELDS: readonly Field[] = [
  { label: 'Minimum supported', show: rules => orEmpty(rules.minSupportedVersion) },
  { label: 'Recommended', show: rules => orEmpty(rules.recommendedVersion) },
  { label: 'Blocked', show: rules => list(rules.blockedVersions) },
  { label: 'Store URL', show: rules => rules.storeUrl ?? 'default' },
  { label: 'Prompt interval', show: rules => `${rules.softPromptIntervalHours} h` },
  {
    label: 'Approval',
    show: rules => (rules.approvalPolicy === null ? 'none' : describeApprovalPolicy(rules.approvalPolicy)),
  },
  {
    label: 'Message',
    show: rules =>
      Object.entries(rules.messages)
        .map(([locale, message]) => `${locale}: ${message.title}`)
        .join(' · '),
  },
];

/** One line per field that differs: "Minimum supported: 2.0.0 → 2.1.0". With no `before`
 * (the first policy), every field is listed as set. */
export function diffRules(before: VersionPolicyRules | null, after: VersionPolicyRules): string[] {
  return FIELDS.flatMap(field => {
    const next = field.show(after);
    if (before === null) {
      return [`${field.label}: ${next}`];
    }
    const previous = field.show(before);
    return previous === next ? [] : [`${field.label}: ${previous} → ${next}`];
  });
}

/** Versions typed as a list: split on commas and whitespace, blanks dropped. */
export function splitVersions(text: string): string[] {
  // eslint-disable-next-line sonarjs/null-dereference -- text is a string, never null
  return text.split(/[\s,]+/u).filter(part => part !== '');
}
