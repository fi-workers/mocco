// Production composition root for the credential domain. Lazy so builds don't need
// env at import. Like governance/execution (and unlike integration, which is gated
// on the GitHub App env), the credential allowlist has NO external dependency — it
// is always available, so `getCredential()` never returns undefined and the tRPC
// context carries it non-optionally. The broker + provider land in PR2.
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { getDb } from '@backend/infra/db/client';

export interface Credential {
  grants: GrantService;
}

const state: { credential?: Credential } = {};

/** The credential services. Always available (no external dependency to gate on). */
export function getCredential(): Credential {
  if (!state.credential) {
    const db = getDb();
    state.credential = {
      grants: new GrantService({ grants: new CredentialGrantRepo(db) }),
    };
  }
  return state.credential;
}
