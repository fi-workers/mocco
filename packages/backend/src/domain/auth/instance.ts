// Production composition root — the one place the app DB binds to the vendor
// provider and the services wrap it. Lazy so builds don't need env at import.

import { AuthService } from '@backend/domain/auth/AuthService';
import { mcpResourceOf, resolveAuthOrigins } from '@backend/domain/auth/origins';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

export interface Services {
  auth: AuthService;
  workspace: WorkspaceService;
}

const state: { services?: Services } = {};

export function getServices(): Services {
  if (!state.services) {
    const env = getEnv();
    const { baseUrl, trustedOrigins } = resolveAuthOrigins({
      serviceDomain: env.SERVICE_DOMAIN,
      vercelEnv: env.VERCEL_ENV,
      vercelUrl: env.VERCEL_URL,
      vercelBranchUrl: env.VERCEL_BRANCH_URL,
    });
    const origins = { baseUrl, trustedOrigins };
    const mcpResource = mcpResourceOf(origins);
    if (mcpResource === undefined) {
      // The MCP resource identifier is baked into every token this provider issues, so
      // there is nothing safe to fall back to. SERVICE_DOMAIN is the canonical host
      // (docs/reference/env.md); without it we cannot say where this server lives.
      throw new Error('SERVICE_DOMAIN is required: the MCP resource identifier is derived from it');
    }
    const provider = createProvider(getDb(), { secret: env.AUTH_SECRET, baseUrl, trustedOrigins, mcpResource });
    state.services = { auth: new AuthService(provider), workspace: new WorkspaceService(provider) };
  }
  return state.services;
}
