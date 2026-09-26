import { OtaTools } from '@mocco/common/ota';

import { CredentialUnavailableError } from '@backend/domain/credential/errors';
import { externalCredentialAad } from '@backend/domain/ota/ExternalCredentialService';

import type { CredentialIssueRequest, CredentialProvider, IssuedCredentials } from '@backend/domain/credential/ports';
import type { OtaExternalCredentialRepo } from '@backend/domain/ota/repos/ota-external-credential.repo';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
import type { OtaTool } from '@mocco/common/ota';

/**
 * The credential-broker provider for one external OTA tool: it releases the stored,
 * sealed publishing token named by the broker `role`, looked up in the RUN's workspace.
 * The broker has already checked the gate and the allowlist; this only resolves the
 * secret. A missing credential or unconfigured secret storage is CredentialUnavailableError
 * (an audited DENY). The ttl bounds Mocco's grant, not the token: static tokens don't expire.
 */
export class ExternalTokenProvider implements CredentialProvider {
  constructor(
    private readonly tool: OtaTool,
    private readonly deps: { credentials: OtaExternalCredentialRepo; secretBox: () => SecretBox },
  ) {}

  async issue(request: CredentialIssueRequest): Promise<IssuedCredentials> {
    const row = await this.deps.credentials.findForIssue(request.workspaceId, this.tool, request.role);
    if (row === undefined) {
      throw new CredentialUnavailableError(`no ${this.tool} credential named ${request.role}`);
    }
    let value: string;
    try {
      value = this.deps.secretBox().open(row.secretSealed, externalCredentialAad(row.id));
    } catch (error) {
      throw new CredentialUnavailableError('the stored credential could not be opened', { cause: error });
    }
    return {
      provider: request.provider,
      role: request.role,
      expiresAt: new Date(Date.now() + request.ttlSeconds * 1000),
      value,
    };
  }
}

/** The tools that get a provider (every OTA tool). */
export const EXTERNAL_TOKEN_TOOLS: readonly OtaTool[] = Object.values(OtaTools);
