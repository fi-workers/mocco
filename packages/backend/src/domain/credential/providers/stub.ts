import type { CredentialIssueRequest, CredentialProvider, IssuedCredentials } from '@backend/domain/credential/ports';

/** The clearly-fake credential value the stub returns — never a real secret. The
 * real AWS OIDC STS provider replaces this whole class behind the port. */
const STUB_CREDENTIAL_VALUE = 'stub-credential';

/** A `CredentialProvider` that mints a clearly-fake credential on ALLOW (slice 7,
 * PR2). The broker's fail-closed decision is what matters this slice; issuing a real
 * cloud credential (AWS OIDC STS) is a later, user-side swap behind the same port.
 * `expiresAt` reflects the requested ttl so callers can treat it like the real one. */
export class StubCredentialProvider implements CredentialProvider {
  private readonly value = STUB_CREDENTIAL_VALUE;

  async issue(request: CredentialIssueRequest): Promise<IssuedCredentials> {
    return await Promise.resolve({
      provider: request.provider,
      role: request.role,
      expiresAt: new Date(Date.now() + request.ttlSeconds * 1000),
      value: this.value,
    });
  }
}
