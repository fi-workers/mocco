import { describe, it, expect } from 'vitest';

import { evaluateGrant, GrantDenials } from '@backend/domain/credential/evaluate-grant';

import type { CredentialGrant, GrantRequest } from '@backend/domain/credential/evaluate-grant';

const request: GrantRequest = { provider: 'aws', role: 'deploy-role', ttl: 900 };
const grant: CredentialGrant = { provider: 'aws', role: 'deploy-role', maxTtlSeconds: 3600 };

describe('evaluateGrant', () => {
  it('denies when no grant matched', () => {
    expect(evaluateGrant(request, undefined)).toEqual({ allowed: false, reason: GrantDenials.noGrant });
  });

  it('denies when the provider does not match', () => {
    expect(evaluateGrant({ ...request, provider: 'gcp' }, grant)).toEqual({
      allowed: false,
      reason: GrantDenials.providerMismatch,
    });
  });

  it('denies when the role does not match', () => {
    expect(evaluateGrant({ ...request, role: 'other-role' }, grant)).toEqual({
      allowed: false,
      reason: GrantDenials.roleMismatch,
    });
  });

  it('denies when the requested ttl exceeds the grant max', () => {
    expect(evaluateGrant({ ...request, ttl: grant.maxTtlSeconds + 1 }, grant)).toEqual({
      allowed: false,
      reason: GrantDenials.ttlExceedsMax,
    });
  });

  it('allows an exact provider/role match within the ttl ceiling', () => {
    expect(evaluateGrant(request, grant)).toEqual({ allowed: true });
  });

  it('allows when the requested ttl equals the grant max (boundary)', () => {
    expect(evaluateGrant({ ...request, ttl: grant.maxTtlSeconds }, grant)).toEqual({ allowed: true });
  });
});
