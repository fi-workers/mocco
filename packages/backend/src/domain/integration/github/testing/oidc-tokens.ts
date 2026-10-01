// Test-only: a local stand-in for GitHub's OIDC issuer — a key pair, its JWKS, and
// tokens shaped like a GitHub Actions job's. Not imported by production code.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { GITHUB_OIDC_ISSUER } from '@backend/domain/integration/github/oidc';

import type { GitHubOidcClaims } from '@backend/domain/integration/github/oidc';

export const REPOSITORY_ID = '123456789';

export const jobClaims = (overrides: Partial<GitHubOidcClaims> = {}): GitHubOidcClaims => ({
  repository_id: REPOSITORY_ID,
  repository: 'acme/mobile',
  repository_owner_id: '42',
  ref: 'refs/heads/main',
  job_workflow_ref: 'acme/mobile/.github/workflows/ota.yml@refs/heads/main',
  event_name: 'push',
  ...overrides,
});

export async function createTestIssuer() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const other = await generateKeyPair('RS256');

  /** A signed job token. `opts` bend the issuer, audience, expiry or signing key. */
  const tokenFor = async (
    claims: Record<string, unknown>,
    opts: { audience: string; issuer?: string; expiresIn?: string; isForeignKey?: boolean },
  ) =>
    await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.issuer ?? GITHUB_OIDC_ISSUER)
      .setAudience(opts.audience)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m')
      .sign(opts.isForeignKey === true ? other.privateKey : privateKey);

  return { keys, tokenFor };
}
