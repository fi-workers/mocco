// Production composition root — the one place the app DB binds to the vendor
// provider and the services wrap it. Lazy so builds don't need env at import.
import { getEnv } from '../../infra/config/env';
import { getDb } from '../../infra/db/client';

import { AuthService } from './AuthService';
import { resolveAuthOrigins } from './origins';
import { createProvider } from './provider';
import { WorkspaceService } from './WorkspaceService';

export interface Services {
  auth: AuthService;
  workspace: WorkspaceService;
}

const state: { services?: Services } = {};

export function getServices(): Services {
  if (!state.services) {
    const env = getEnv();
    const { baseUrl, trustedOrigins } = resolveAuthOrigins({
      authUrl: env.AUTH_URL,
      vercelEnv: env.VERCEL_ENV,
      vercelUrl: env.VERCEL_URL,
      vercelBranchUrl: env.VERCEL_BRANCH_URL,
    });
    const provider = createProvider(getDb(), { secret: env.AUTH_SECRET, baseUrl, trustedOrigins });
    state.services = { auth: new AuthService(provider), workspace: new WorkspaceService(provider) };
  }
  return state.services;
}
