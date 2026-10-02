// A project's messenger setup (#95): turning it on mints the identity secret the app's
// server signs user ids with. The secret is shown once (enable or rotate), sealed at
// rest, and every change is audited.
import { AuditActions } from '@mocco/common/audit';
import { DEFAULT_MESSENGER_CATEGORIES } from '@mocco/common/messenger';

import { MessengerAlreadyEnabledError, MessengerNotEnabledError } from '@backend/domain/messenger/errors';
import { identitySecretAad, newIdentitySecret } from '@backend/domain/messenger/identity';
import { MessengerSettingsRepo } from '@backend/domain/messenger/repos/settings.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
import type { Db } from '@backend/infra/db/types';
import type { MessengerCategory } from '@mocco/common/messenger';

export interface MessengerSettingsDeps {
  db: Db;
  audit: AuditService;
  /** Lazy: a deploy without SECRETS_ENCRYPTION_KEYS boots; only sealing fails. */
  box: () => SecretBox;
}

export class MessengerSettingsService {
  constructor(private readonly deps: MessengerSettingsDeps) {}

  private async require(workspaceId: string, projectId: string) {
    const row = await new MessengerSettingsRepo(this.deps.db).find(workspaceId, projectId);
    if (row === undefined) {
      throw new MessengerNotEnabledError(projectId);
    }
    return row;
  }

  /** The settings without the secret, or undefined when the messenger is off. */
  async get(workspaceId: string, projectId: string) {
    const row = await new MessengerSettingsRepo(this.deps.db).find(workspaceId, projectId);
    return row === undefined
      ? undefined
      : { categories: row.categories, allowGuests: row.allowGuests, updatedAt: row.updatedAt };
  }

  /** Turn the messenger on. Returns the identity secret, the only time it is shown. */
  async enable(workspaceId: string, projectId: string, actorUserId: string): Promise<{ identitySecret: string }> {
    const identitySecret = newIdentitySecret();
    const inserted = await new MessengerSettingsRepo(this.deps.db).insert({
      workspaceId,
      projectId,
      identitySecretSealed: this.deps.box().seal(identitySecret, identitySecretAad(projectId)),
      categories: DEFAULT_MESSENGER_CATEGORIES.map(category => ({ ...category })),
    });
    if (inserted === undefined) {
      throw new MessengerAlreadyEnabledError(projectId);
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.messengerEnabled,
      subjectType: 'project',
      subjectId: projectId,
      payload: {},
    });
    return { identitySecret };
  }

  /** Replace the identity secret. Hashes signed with the old one stop working at once. */
  async rotateSecret(workspaceId: string, projectId: string, actorUserId: string) {
    await this.require(workspaceId, projectId);
    const identitySecret = newIdentitySecret();
    await new MessengerSettingsRepo(this.deps.db).update(workspaceId, projectId, {
      identitySecretSealed: this.deps.box().seal(identitySecret, identitySecretAad(projectId)),
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.messengerSecretRotated,
      subjectType: 'project',
      subjectId: projectId,
      payload: {},
    });
    return { identitySecret };
  }

  async setCategories(workspaceId: string, projectId: string, actorUserId: string, categories: MessengerCategory[]) {
    await this.require(workspaceId, projectId);
    const row = await new MessengerSettingsRepo(this.deps.db).update(workspaceId, projectId, { categories });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.messengerCategoriesChanged,
      subjectType: 'project',
      subjectId: projectId,
      payload: { categories: categories.map(category => category.key) },
    });
    return { categories: row.categories };
  }

  /** Let people who aren't signed in write (they leave an email), or stop them. Audited. */
  async setAllowGuests(workspaceId: string, projectId: string, actorUserId: string, areGuestsAllowed: boolean) {
    await this.require(workspaceId, projectId);
    const row = await new MessengerSettingsRepo(this.deps.db).update(workspaceId, projectId, {
      allowGuests: areGuestsAllowed,
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.messengerGuestsChanged,
      subjectType: 'project',
      subjectId: projectId,
      payload: { allowGuests: areGuestsAllowed },
    });
    return { allowGuests: row.allowGuests };
  }

  /** The settings with the identity secret opened (for verifying user hashes). */
  async withSecret(workspaceId: string, projectId: string) {
    const row = await this.require(workspaceId, projectId);
    return {
      categories: row.categories,
      allowGuests: row.allowGuests,
      identitySecret: this.deps.box().open(row.identitySecretSealed, identitySecretAad(projectId)),
    };
  }
}
