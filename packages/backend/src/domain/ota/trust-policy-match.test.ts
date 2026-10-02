import { describe, expect, it } from 'vitest';

import { jobClaims, REPOSITORY_ID } from '@backend/domain/integration/github/testing/oidc-tokens';
import { isRefMatch, matchingPolicy } from '@backend/domain/ota/trust-policy-match';

import type { TrustPolicyRow } from '@backend/domain/ota/repos/trust-policy.repo';

const policy = (overrides: Partial<TrustPolicyRow> = {}): TrustPolicyRow => ({
  id: 'p1',
  workspaceId: 'w',
  appId: 'a',
  provider: 'github',
  repositoryId: BigInt(REPOSITORY_ID),
  repository: 'acme/mobile',
  refPattern: 'refs/heads/main',
  workflowRef: null,
  environment: null,
  allowedChannels: ['staging'],
  createdByUserId: null,
  createdAt: new Date(),
  ...overrides,
});

describe('trust policy matching', () => {
  it('matches refs exactly, or with * wildcards', () => {
    expect(isRefMatch('refs/heads/main', 'refs/heads/main')).toBe(true);
    expect(isRefMatch('refs/heads/main', 'refs/heads/main2')).toBe(false);
    expect(isRefMatch('refs/tags/v*', 'refs/tags/v1.2.0')).toBe(true);
    expect(isRefMatch('refs/tags/v*', 'refs/heads/v1')).toBe(false);
    expect(isRefMatch('refs/heads/release/*/final', 'refs/heads/release/2/final')).toBe(true);
    expect(isRefMatch('refs/heads/release/*/final', 'refs/heads/release/2/draft')).toBe(false);
  });

  it('needs the same repository id, ref, and workflow and environment when the policy pins them', () => {
    expect(matchingPolicy([policy()], jobClaims())?.id).toBe('p1');
    // A fork (or a renamed-into-place repository) has a different numeric id.
    expect(matchingPolicy([policy()], jobClaims({ repository_id: '999', repository: 'acme/mobile' }))).toBeUndefined();
    expect(matchingPolicy([policy()], jobClaims({ ref: 'refs/pull/7/merge' }))).toBeUndefined();
    const pinned = policy({
      workflowRef: 'acme/mobile/.github/workflows/ota.yml@refs/heads/main',
      environment: 'prod',
    });
    expect(matchingPolicy([pinned], jobClaims({ environment: 'prod' }))?.id).toBe('p1');
    expect(matchingPolicy([pinned], jobClaims())).toBeUndefined();
    expect(
      matchingPolicy(
        [pinned],
        jobClaims({ environment: 'prod', job_workflow_ref: 'acme/mobile/.github/workflows/x.yml@refs/heads/main' }),
      ),
    ).toBeUndefined();
  });
});
