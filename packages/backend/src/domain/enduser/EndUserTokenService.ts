// End-user tokens (platform foundations F2, feedback design §6). The project's server signs a
// short-lived HS256 JWT for its signed-in user with the project's identity secret, the same
// secret the messenger's `userHash` uses (`signIdentity` in @mocco/node). An app sends it as
// `Authorization: Bearer …` next to its publishable key. The secret binds the token to its
// project, so another project's token never verifies. Nothing is stored per token.
import { z } from 'zod';

import { EndUserTokenRefusals, EndUserTokenRejectedError } from '@backend/domain/enduser/errors';
import { END_USER_TOKEN_CLOCK_SKEW_SECONDS, verifyHs256 } from '@backend/domain/enduser/jwt';

/** The longest a token may be valid for. */
export const END_USER_TOKEN_MAX_TTL_SECONDS = 60 * 60;

/** `sub` is the end user's id as the app knows them (the messenger's and feedback's id space). */
const claimsSchema = z.object({ sub: z.string().trim().min(1).max(255), exp: z.number() });

/** Where a project's identity secret comes from. Today the messenger settings hold it. */
export interface IdentitySecrets {
  identitySecretOf(workspaceId: string, projectId: string): Promise<string | undefined>;
}

export interface EndUser {
  /** The app's id for the end user (the token's `sub`). */
  endUserId: string;
}

export class EndUserTokenService {
  constructor(private readonly deps: { secrets: IdentitySecrets; now?: () => Date }) {}

  /** The end user the token speaks for in the project, or EndUserTokenRejectedError. Claims
   * other than `sub` and `exp` (an email, a name) are ignored and never stored. */
  async verify(scope: { workspaceId: string; projectId: string }, token: string): Promise<EndUser> {
    const secret = await this.deps.secrets.identitySecretOf(scope.workspaceId, scope.projectId);
    if (secret === undefined) {
      throw new EndUserTokenRejectedError(EndUserTokenRefusals.noSecret);
    }
    const now = this.deps.now?.() ?? new Date();
    const verdict = await verifyHs256(token, secret, now);
    if (!verdict.ok) {
      throw new EndUserTokenRejectedError(
        verdict.reason === 'expired' ? EndUserTokenRefusals.expired : EndUserTokenRefusals.invalid,
      );
    }
    const claims = claimsSchema.safeParse(verdict.payload);
    if (!claims.success) {
      throw new EndUserTokenRejectedError(EndUserTokenRefusals.invalid);
    }
    const latest = now.getTime() / 1000 + END_USER_TOKEN_MAX_TTL_SECONDS + END_USER_TOKEN_CLOCK_SKEW_SECONDS;
    if (claims.data.exp > latest) {
      throw new EndUserTokenRejectedError(EndUserTokenRefusals.tooLong);
    }
    return { endUserId: claims.data.sub };
  }
}
