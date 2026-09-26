// Production composition root for the credential domain. Lazy so builds don't need
// env at import. Like governance/execution (and unlike integration, which is gated
// on the GitHub App env), the credential domain has NO external dependency — the
// broker's `CredentialProvider` is the stub this slice (the real AWS OIDC STS
// provider is a later, user-side swap behind the port), so `getCredential()` never
// returns undefined and the tRPC/ext contexts carry it non-optionally.
import { OtaCredentialProviders } from '@mocco/common/ota';

import { getAudit } from '@backend/domain/audit/instance';
import { CredentialBroker } from '@backend/domain/credential/CredentialBroker';
import { GrantService } from '@backend/domain/credential/GrantService';
import { RoutingCredentialProvider } from '@backend/domain/credential/providers/routing';
import { StubCredentialProvider } from '@backend/domain/credential/providers/stub';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { EXTERNAL_TOKEN_TOOLS, ExternalTokenProvider } from '@backend/domain/ota/providers/external-token';
import { OtaExternalCredentialRepo } from '@backend/domain/ota/repos/ota-external-credential.repo';
import { getSecretBox } from '@backend/infra/crypto/instance';
import { getDb } from '@backend/infra/db/client';

export interface Credential {
  grants: GrantService;
  /** The fail-closed enforcement (slice 7, PR2) the ext `/credentials` route delegates to. */
  broker: CredentialBroker;
}

const state: { credential?: Credential } = {};

/** The credential services. Always available (no external dependency to gate on). */
export function getCredential(): Credential {
  if (!state.credential) {
    const db = getDb();
    const grants = new CredentialGrantRepo(db);
    state.credential = {
      grants: new GrantService({ grants }),
      broker: new CredentialBroker({
        runs: new RunRepo(db),
        steps: new RunStepRepo(db),
        runGates: new RunGateRepo(db),
        configs: new CommitConfigRepo(db),
        commits: new CommitRepo(db),
        grants,
        // OTA tools' sealed publishing tokens (ota-<tool>); every other provider id is
        // still the stub until the real AWS STS provider lands.
        provider: new RoutingCredentialProvider(
          new Map(
            EXTERNAL_TOKEN_TOOLS.map(tool => [
              OtaCredentialProviders[tool],
              new ExternalTokenProvider(tool, {
                credentials: new OtaExternalCredentialRepo(db),
                secretBox: getSecretBox,
              }),
            ]),
          ),
          new StubCredentialProvider(),
        ),
        audit: getAudit().audit,
      }),
    };
  }
  return state.credential;
}
