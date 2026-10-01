// Production composition root for API keys. Lazy so builds don't need env at import.
import { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import { ApiKeyRepo } from '@backend/domain/apikey/repos/api-key.repo';
import { getAudit } from '@backend/domain/audit/instance';
import { getProjectDomain } from '@backend/domain/project/instance';
import { getDb } from '@backend/infra/db/client';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { Db } from '@backend/infra/db/types';

export function createApiKeyService(db: Db, deps: { projects: ProjectService; audit: AuditService }): ApiKeyService {
  return new ApiKeyService({ keys: new ApiKeyRepo(db), ...deps });
}

const state: { apiKeys?: ApiKeyService } = {};

export function getApiKeys(): ApiKeyService {
  state.apiKeys ??= createApiKeyService(getDb(), {
    projects: getProjectDomain().projects,
    audit: getAudit().audit,
  });
  return state.apiKeys;
}
