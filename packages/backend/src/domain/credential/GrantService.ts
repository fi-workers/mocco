import { CredentialGrantNotFoundError } from '@backend/domain/credential/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import type { CredentialGrantCreateInput } from '@mocco/common/credential';

export interface GrantServiceDeps {
  grants: CredentialGrantRepo;
}

/**
 * Owns the credential allowlist: a workspace's `mocco_credential_grants` — the
 * authority the broker (PR2) matches a step's `credential` request against. Anemic
 * domain (ADR 0012) — reaches the DB only through the repo, maps its
 * `EntityNotFoundError` to a domain error, and narrows to the wire shape via
 * `.output` at the router. Every operation is workspace-scoped.
 */
export class GrantService {
  constructor(private readonly deps: GrantServiceDeps) {}

  /** A grant owned by the workspace, or throw CredentialGrantNotFoundError. A grant
   * is NEVER resolved by id alone — always through the workspace-scoped repo. */
  private async requireGrant(workspaceId: string, grantId: string) {
    try {
      return await this.deps.grants.getByIdInWorkspace(workspaceId, grantId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new CredentialGrantNotFoundError(grantId, { cause: error });
      }
      throw error;
    }
  }

  /** Create an allowlist grant in the workspace. */
  async create(workspaceId: string, input: CredentialGrantCreateInput) {
    return await this.deps.grants.create({ workspaceId, ...input });
  }

  /** The workspace's grants, oldest first. */
  async list(workspaceId: string) {
    return await this.deps.grants.listByWorkspace(workspaceId);
  }

  /** Delete a grant owned by the workspace. Throws CredentialGrantNotFoundError for
   * a foreign or unknown grant. */
  async delete(workspaceId: string, grantId: string): Promise<void> {
    await this.requireGrant(workspaceId, grantId);
    await this.deps.grants.delete(workspaceId, grantId);
  }
}
