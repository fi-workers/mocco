// GitHub Actions OIDC (OTA design §6.2): verify a job's ID token — signature against
// GitHub's JWKS, issuer, audience and expiry — and return the claims trust policies
// match on. The jose leaf; the remote key set caches GitHub's keys and refetches on an
// unknown `kid`.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import { OidcTokenRejectedError } from '@backend/domain/integration/github/errors';

import type { JWTVerifyGetKey } from 'jose';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/** The claims Mocco matches. `repository_id` is numeric, so a rename can't hijack a policy. */
const claimsSchema = z.object({
  repository_id: z.string().regex(/^\d+$/u),
  repository: z.string(),
  repository_owner_id: z.string(),
  ref: z.string(),
  job_workflow_ref: z.string(),
  environment: z.string().optional(),
  event_name: z.string().optional(),
  sha: z.string().optional(),
  run_id: z.string().optional(),
});
export type GitHubOidcClaims = z.infer<typeof claimsSchema>;

export class GitHubOidcVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly opts: {
      /** The `aud` the job must request: Mocco's public API origin. */
      audience: string;
      /** Defaults to GitHub's remote JWKS; tests pass a local key set. */
      keys?: JWTVerifyGetKey;
      now?: () => Date;
    },
  ) {
    this.keys = opts.keys ?? createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));
  }

  async verify(token: string): Promise<GitHubOidcClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: this.opts.audience,
        algorithms: ['RS256'],
        ...(this.opts.now !== undefined && { currentDate: this.opts.now() }),
      }));
    } catch (error) {
      throw new OidcTokenRejectedError(
        `the token didn't verify: ${error instanceof Error ? error.message : 'unknown'}`,
        {
          cause: error,
        },
      );
    }
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) {
      throw new OidcTokenRejectedError('the token lacks the GitHub Actions claims');
    }
    return claims.data;
  }
}
