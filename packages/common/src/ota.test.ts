import { describe, expect, it } from 'vitest';

import {
  classifyPolicyChange,
  compareVersions,
  evaluateVersionPolicy,
  PolicyDirections,
  isVersionFloorRaised,
  VersionStatuses,
  versionPolicyRulesSchema,
  versionSchema,
} from './ota';

import type { VersionPolicyRules } from './ota';

const base: VersionPolicyRules = {
  minSupportedVersion: '2.0.0',
  recommendedVersion: '2.4.0',
  blockedVersions: ['2.3.1'],
  messages: { en: { title: 'Update', body: 'Please update', action: 'Update' } },
  storeUrl: 'https://apps.apple.com/app/id1',
  softPromptIntervalHours: 72,
  approvalPolicy: { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false },
};

describe('versions', () => {
  it('accepts 1–4 numeric segments only', () => {
    expect(['2', '2.3', '2.3.1', '10.0.0.400'].every(v => versionSchema.safeParse(v).success)).toBe(true);
    expect(['', 'v2', '2.3.1-beta', '2..1', '1.2.3.4.5'].some(v => versionSchema.safeParse(v).success)).toBe(false);
  });

  it('compares numerically with missing segments as zero', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.3', '2.3.0')).toBe(0);
    expect(compareVersions('1.9', '2')).toBeLessThan(0);
  });
});

describe('evaluateVersionPolicy', () => {
  it('blocks blocked and below-minimum versions, prompts below recommended, passes the rest', () => {
    expect(evaluateVersionPolicy(base, '2.3.1')).toBe(VersionStatuses.hard);
    expect(evaluateVersionPolicy(base, '1.9.9')).toBe(VersionStatuses.hard);
    expect(evaluateVersionPolicy(base, '2.0')).toBe(VersionStatuses.soft);
    expect(evaluateVersionPolicy(base, '2.4.0')).toBe(VersionStatuses.ok);
    expect(
      evaluateVersionPolicy({ minSupportedVersion: null, recommendedVersion: null, blockedVersions: [] }, '0.1'),
    ).toBe(VersionStatuses.ok);
  });
});

describe('classifyPolicyChange', () => {
  it('treats raising a floor, blocking a version, a new store URL or a changed approval policy as tightening', () => {
    expect(classifyPolicyChange(base, { ...base, minSupportedVersion: '2.1.0' })).toBe(PolicyDirections.tighten);
    expect(classifyPolicyChange(base, { ...base, recommendedVersion: '2.5' })).toBe(PolicyDirections.tighten);
    expect(classifyPolicyChange(base, { ...base, blockedVersions: ['2.3.1', '2.3.2'] })).toBe(PolicyDirections.tighten);
    expect(classifyPolicyChange(base, { ...base, storeUrl: 'https://evil.example' })).toBe(PolicyDirections.tighten);
    expect(classifyPolicyChange(base, { ...base, approvalPolicy: null })).toBe(PolicyDirections.tighten);
  });

  it('treats lowering a floor or unblocking as relaxing, and copy edits as neither', () => {
    expect(classifyPolicyChange(base, { ...base, minSupportedVersion: '1.9' })).toBe(PolicyDirections.relax);
    expect(classifyPolicyChange(base, { ...base, recommendedVersion: null })).toBe(PolicyDirections.relax);
    expect(classifyPolicyChange(base, { ...base, blockedVersions: [] })).toBe(PolicyDirections.relax);
    expect(classifyPolicyChange(base, { ...base, softPromptIntervalHours: 24 })).toBe(PolicyDirections.none);
    expect(classifyPolicyChange(base, { ...base, minSupportedVersion: '2' })).toBe(PolicyDirections.none);
  });

  it('a mixed change counts as tightening', () => {
    expect(classifyPolicyChange(base, { ...base, minSupportedVersion: '2.1', blockedVersions: [] })).toBe(
      PolicyDirections.tighten,
    );
  });

  it('the first policy with any floor tightens; setting an approval policy for the first time does not', () => {
    expect(classifyPolicyChange(null, base)).toBe(PolicyDirections.tighten);
    expect(
      classifyPolicyChange(null, {
        ...base,
        minSupportedVersion: null,
        recommendedVersion: null,
        blockedVersions: [],
        storeUrl: null,
      }),
    ).toBe(PolicyDirections.none);
  });
});

describe('isVersionFloorRaised', () => {
  it('is true only when a minimum or recommended version goes up', () => {
    expect(isVersionFloorRaised(base, { ...base, recommendedVersion: '2.5' })).toBe(true);
    expect(isVersionFloorRaised(base, { ...base, blockedVersions: ['1.0'] })).toBe(false);
    expect(isVersionFloorRaised(null, base)).toBe(true);
  });
});

describe('versionPolicyRulesSchema', () => {
  it('requires an en message and recommended ≥ minimum', () => {
    expect(versionPolicyRulesSchema.safeParse(base).success).toBe(true);
    expect(versionPolicyRulesSchema.safeParse({ ...base, messages: {} }).success).toBe(false);
    expect(versionPolicyRulesSchema.safeParse({ ...base, recommendedVersion: '1.0' }).success).toBe(false);
  });
});
