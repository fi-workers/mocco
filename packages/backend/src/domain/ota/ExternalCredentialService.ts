import { createHash, randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { OtaCredentialProviders } from '@mocco/common/ota';

import {
  OtaCredentialNameTakenError,
  OtaCredentialNotFoundError,
  SecretStorageUnavailableError,
} from '@backend/domain/ota/errors';
import { SecretBoxError } from '@backend/infra/crypto/errors';
import { EntityNotFoundError, UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { OtaExternalCredentialRepo } from '@backend/domain/ota/repos/ota-external-credential.repo';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
import type { OtaExternalCredentialCreateInput } from '@mocco/common/ota';

export interface ExternalCredentialServiceDeps {
  credentials: OtaExternalCredentialRepo;
  projects: ProjectService;
  audit: AuditService;
  /** Resolved lazily: a deploy without SECRETS_ENCRYPTION_KEYS boots, and only storing
   * or releasing a secret fails. */
  secretBox: () => SecretBox;
}

const NAME_UNIQUE = 'mocco_ota_external_credentials_workspace_name_uq';
const AAD_TABLE = 'mocco_ota_external_credentials';

/** The SecretBox AAD binding a sealed secret to its row. */
export const externalCredentialAad = (id: string): string => `${AAD_TABLE}:${id}`;

const fingerprintOf = (secret: string): string => createHash('sha256').update(secret).digest('hex').slice(0, 8);

type CredentialRow = Awaited<ReturnType<OtaExternalCredentialRepo['getInProject']>>;

/** A row plus its broker provider id. The router's `.output()` strips `secretSealed` (egress
 * narrowing); it is ciphertext either way, never the plaintext secret. */
function view(row: CredentialRow) {
  return { ...row, provider: OtaCredentialProviders[row.tool] };
}

/**
 * Phase 1 of the OTA release control design: the team's existing OTA tool keeps
 * publishing, but its publishing token lives here, sealed, and the credential broker
 * releases it only to a pipeline step that reached a resumed gate. The secret is
 * write-only — it is never returned; the UI shows its fingerprint.
 */
export class ExternalCredentialService {
  constructor(private readonly deps: ExternalCredentialServiceDeps) {}

  private box(): SecretBox {
    try {
      return this.deps.secretBox();
    } catch (error) {
      if (error instanceof SecretBoxError) {
        throw new SecretStorageUnavailableError({ cause: error });
      }
      throw error;
    }
  }

  private async require(workspaceId: string, projectId: string, id: string) {
    await this.deps.projects.requireProject(workspaceId, projectId);
    try {
      return await this.deps.credentials.getInProject(workspaceId, projectId, id);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new OtaCredentialNotFoundError(id, { cause: error });
      }
      throw error;
    }
  }

  async list(workspaceId: string, projectId: string) {
    await this.deps.projects.requireProject(workspaceId, projectId);
    const rows = await this.deps.credentials.listByProject(workspaceId, projectId);
    return rows.map(row => view(row));
  }

  /** Store a new credential. Throws OtaCredentialNameTakenError for a taken name. */
  async create(workspaceId: string, projectId: string, actorUserId: string, input: OtaExternalCredentialCreateInput) {
    await this.deps.projects.requireProject(workspaceId, projectId);
    const id = randomUUID();
    const secretSealed = this.box().seal(input.secret, externalCredentialAad(id));
    try {
      const row = await this.deps.credentials.create({
        id,
        workspaceId,
        projectId,
        tool: input.tool,
        name: input.name,
        secretSealed,
        secretFingerprint: fingerprintOf(input.secret),
        createdByUserId: actorUserId,
      });
      await this.deps.audit.record(workspaceId, {
        actorUserId,
        action: AuditActions.otaCredentialCreated,
        subjectType: 'ota_external_credential',
        subjectId: id,
        payload: { tool: input.tool, name: input.name, fingerprint: row.secretFingerprint },
      });
      return view(row);
    } catch (error) {
      if (error instanceof UniqueConstraintError && error.constraint === NAME_UNIQUE) {
        throw new OtaCredentialNameTakenError(input.name, { cause: error });
      }
      throw error;
    }
  }

  /** Replace the secret (after rotating it in the tool). */
  async rotate(workspaceId: string, projectId: string, actorUserId: string, id: string, secret: string) {
    await this.require(workspaceId, projectId, id);
    const row = await this.deps.credentials.updateSecret(workspaceId, id, {
      secretSealed: this.box().seal(secret, externalCredentialAad(id)),
      secretFingerprint: fingerprintOf(secret),
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.otaCredentialRotated,
      subjectType: 'ota_external_credential',
      subjectId: id,
      payload: { fingerprint: row.secretFingerprint },
    });
    return view(row);
  }

  async delete(workspaceId: string, projectId: string, actorUserId: string, id: string): Promise<void> {
    const row = await this.require(workspaceId, projectId, id);
    await this.deps.credentials.delete(workspaceId, id);
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.otaCredentialDeleted,
      subjectType: 'ota_external_credential',
      subjectId: id,
      payload: { tool: row.tool, name: row.name },
    });
  }
}
