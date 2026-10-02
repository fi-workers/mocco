import { ApiKeyKinds, ApiKeyPrefixes } from '@mocco/common/apikey';
import { AuditActions } from '@mocco/common/audit';

import { ApiKeyNotFoundError } from '@backend/domain/apikey/errors';
import { generateToken, hashToken, kindOfToken } from '@backend/domain/apikey/tokens';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { ApiKeyRepo, ApiKeyRow } from '@backend/domain/apikey/repos/api-key.repo';
import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { ApiKeyCreateInput, ApiKeyDto, ApiKeyKind, ApiScope } from '@mocco/common/apikey';

/** Who a valid key speaks for. `/v1` routes scope every query by it, never by the request. */
export interface ApiPrincipal {
  workspaceId: string;
  projectId: string;
  keyId: string;
  kind: ApiKeyKind;
  scopes: readonly ApiScope[];
}

/** Why a key was refused. `invalid` covers unknown, revoked and expired keys alike, so a
 * caller can't tell which. */
export const ApiKeyRefusals = {
  invalid: 'invalid',
  secretFromBrowser: 'secret_from_browser',
  originNotAllowed: 'origin_not_allowed',
} as const;
export type ApiKeyRefusal = (typeof ApiKeyRefusals)[keyof typeof ApiKeyRefusals];

export type ApiKeyCheck = { ok: true; principal: ApiPrincipal } | { ok: false; refusal: ApiKeyRefusal };

export interface ApiKeyServiceDeps {
  keys: ApiKeyRepo;
  projects: ProjectService;
  audit: AuditService;
  now?: () => Date;
}

/** `last_used_at` is written at most this often per key. */
const TOUCH_INTERVAL_MS = 60_000;

/** The console's view of a key: its kind prefix and last four characters, never the hash. */
export function toApiKeyDto(row: ApiKeyRow): ApiKeyDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    name: row.name,
    hint: `${ApiKeyPrefixes[row.kind]}…${row.last4}`,
    scopes: row.scopes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/** `https://Example.com:443/` → `https://example.com` (the form `web_origins` and an
 * `Origin` header are compared in). Null for anything that isn't an http(s) origin. */
function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * API keys for the public `/v1` surface (ADR 0017). `create` returns the token once and
 * stores only its hash; `authenticate` resolves a presented token to the project it
 * speaks for and applies the browser rules: a secret key from a browser (an `Origin`
 * header) is refused, and a publishable key from a browser must come from one of the
 * project's apps' web origins.
 */
export class ApiKeyService {
  private readonly now: () => Date;

  constructor(private readonly deps: ApiKeyServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async requireKey(workspaceId: string, projectId: string, keyId: string) {
    try {
      return await this.deps.keys.getInProject(workspaceId, projectId, keyId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new ApiKeyNotFoundError(keyId, { cause: error });
      }
      throw error;
    }
  }

  async list(workspaceId: string, projectId: string): Promise<ApiKeyDto[]> {
    await this.deps.projects.requireProject(workspaceId, projectId);
    const rows = await this.deps.keys.listByProject(workspaceId, projectId);
    return rows.map(row => toApiKeyDto(row));
  }

  /** Create a key. The returned `token` is the only time it is ever available. */
  async create(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: ApiKeyCreateInput,
  ): Promise<{ key: ApiKeyDto; token: string }> {
    await this.deps.projects.requireProject(workspaceId, projectId);
    const token = generateToken(input.kind);
    const row = await this.deps.keys.insert({
      workspaceId,
      projectId,
      kind: input.kind,
      name: input.name,
      tokenHash: hashToken(token),
      last4: token.slice(-4),
      scopes: [...new Set(input.scopes)],
      createdByUserId: actorUserId,
      createdAt: this.now(),
      expiresAt: input.expiresAt,
    });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.apiKeyCreated,
      subjectType: 'api_key',
      subjectId: row.id,
      payload: { projectId, kind: row.kind, scopes: row.scopes, name: row.name },
    });
    return { key: toApiKeyDto(row), token };
  }

  /** Revoke a key at once. Revoking twice is a no-op. */
  async revoke(workspaceId: string, projectId: string, actorUserId: string, keyId: string): Promise<void> {
    const row = await this.requireKey(workspaceId, projectId, keyId);
    if (row.revokedAt !== null) {
      return;
    }
    await this.deps.keys.revoke(row.id, this.now());
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.apiKeyRevoked,
      subjectType: 'api_key',
      subjectId: row.id,
      payload: { projectId, kind: row.kind },
    });
  }

  /**
   * Resolve a presented token. `origin` is the request's `Origin` header (absent for
   * servers and native apps). Records the use (throttled) for a valid key.
   */
  async authenticate(token: string, opts: { origin: string | undefined }): Promise<ApiKeyCheck> {
    const kind = kindOfToken(token);
    const row = kind === null ? undefined : await this.deps.keys.findByHash(hashToken(token));
    const now = this.now();
    if (
      row === undefined ||
      row.kind !== kind ||
      row.revokedAt !== null ||
      (row.expiresAt !== null && row.expiresAt <= now)
    ) {
      return { ok: false, refusal: ApiKeyRefusals.invalid };
    }
    if (opts.origin !== undefined) {
      if (row.kind === ApiKeyKinds.secret) {
        return { ok: false, refusal: ApiKeyRefusals.secretFromBrowser };
      }
      const origin = normalizeOrigin(opts.origin);
      const apps = await this.deps.projects.listApps(row.workspaceId, row.projectId);
      const allowed = new Set(
        apps
          .flatMap(app => (app.webOrigins ?? []).map(value => normalizeOrigin(value)))
          .filter(value => value !== null),
      );
      if (origin === null || !allowed.has(origin)) {
        return { ok: false, refusal: ApiKeyRefusals.originNotAllowed };
      }
    }
    await this.deps.keys.touch(row.id, now, TOUCH_INTERVAL_MS);
    return {
      ok: true,
      principal: {
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        keyId: row.id,
        kind: row.kind,
        scopes: row.scopes,
      },
    };
  }
}
