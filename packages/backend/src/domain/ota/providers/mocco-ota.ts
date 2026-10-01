import { CredentialUnavailableError } from '@backend/domain/credential/errors';

import type { CredentialIssueRequest, CredentialProvider, IssuedCredentials } from '@backend/domain/credential/ports';
import type { OtaAppRepo } from '@backend/domain/ota/repos/ota-app.repo';
import type { UploadService } from '@backend/domain/ota/UploadService';

/**
 * The credential-broker provider `mocco-ota`: a gated Mocco run step that names it gets
 * a Mocco-hosted OTA upload session for the app its `role` names (the OTA app id). The
 * broker has already checked the run token, the step, its gate and the workspace
 * allowlist; this mints the session (at most 15 minutes) bound to the run.
 */
export class MoccoOtaProvider implements CredentialProvider {
  constructor(
    private readonly deps: { apps: Pick<OtaAppRepo, 'findById'>; uploads: Pick<UploadService, 'mintSession'> },
  ) {}

  async issue(request: CredentialIssueRequest): Promise<IssuedCredentials> {
    const app = await this.deps.apps.findById(request.role);
    if (app?.workspaceId !== request.workspaceId) {
      throw new CredentialUnavailableError(`no OTA app ${request.role} in this workspace`);
    }
    const session = await this.deps.uploads.mintSession(app, {
      principal: `mocco:run:${request.runId}`,
      actingUserId: request.triggeredByUserId,
      allowedChannels: null,
      ttlSeconds: request.ttlSeconds,
    });
    return {
      provider: request.provider,
      role: request.role,
      expiresAt: session.expiresAt,
      value: session.sessionToken,
    };
  }
}
