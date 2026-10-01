import { describe, expect, it } from 'vitest';

import { GitHubOidcVerifier } from '@backend/domain/integration/github/oidc';
import { createTestIssuer, jobClaims } from '@backend/domain/integration/github/testing/oidc-tokens';

const AUDIENCE = 'https://mocco.test';

describe('GitHubOidcVerifier', () => {
  it('accepts a GitHub job token for Mocco and returns its claims', async () => {
    const issuer = await createTestIssuer();
    const verifier = new GitHubOidcVerifier({ audience: AUDIENCE, keys: issuer.keys });

    const claims = await verifier.verify(await issuer.tokenFor(jobClaims(), { audience: AUDIENCE }));

    expect(claims).toMatchObject({ repository_id: '123456789', ref: 'refs/heads/main' });
  });

  it('rejects another audience, another issuer, an expired token, a foreign key and missing claims', async () => {
    const issuer = await createTestIssuer();
    const verifier = new GitHubOidcVerifier({ audience: AUDIENCE, keys: issuer.keys });
    const tokens = await Promise.all([
      issuer.tokenFor(jobClaims(), { audience: 'https://evil.test' }),
      issuer.tokenFor(jobClaims(), { audience: AUDIENCE, issuer: 'https://evil.test' }),
      issuer.tokenFor(jobClaims(), { audience: AUDIENCE, expiresIn: '-1m' }),
      issuer.tokenFor(jobClaims(), { audience: AUDIENCE, isForeignKey: true }),
      issuer.tokenFor({ repository: 'acme/mobile' }, { audience: AUDIENCE }),
    ]);

    const outcomeOf = async (token: string) => {
      try {
        await verifier.verify(token);
        return 'accepted';
      } catch (error) {
        return error instanceof Error ? error.name : 'unknown';
      }
    };
    const outcomes = await Promise.all(tokens.map(async token => await outcomeOf(token)));

    expect(outcomes).toEqual(Array.from({ length: 5 }, () => 'OidcTokenRejectedError'));
  });
});
