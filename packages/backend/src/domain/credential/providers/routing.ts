import type { CredentialIssueRequest, CredentialProvider, IssuedCredentials } from '@backend/domain/credential/ports';

/**
 * Routes each issue request to the provider registered for its `provider` id, falling
 * back to `fallback` for every other id. The broker's decision logic stays provider-
 * agnostic: it only ever sees one `CredentialProvider`.
 */
export class RoutingCredentialProvider implements CredentialProvider {
  constructor(
    private readonly providers: ReadonlyMap<string, CredentialProvider>,
    private readonly fallback: CredentialProvider,
  ) {}

  async issue(request: CredentialIssueRequest): Promise<IssuedCredentials> {
    return await (this.providers.get(request.provider) ?? this.fallback).issue(request);
  }
}
