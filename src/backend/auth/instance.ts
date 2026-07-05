// Production composition root — the one place the app DB binds to the vendor
// provider and the services wrap it. Lazy so builds don't need env at import.
import { getEnv } from '../config/env';
import { getDb } from '../db/client';

import { createAuthService, type AuthService } from './AuthService';
import { createProvider } from './provider';
import { createWorkspaceService, type WorkspaceService } from './WorkspaceService';

export interface Services {
  auth: AuthService;
  workspace: WorkspaceService;
}

const state: { services?: Services } = {};

export function getServices(): Services {
  if (!state.services) {
    const env = getEnv();
    const provider = createProvider(getDb(), { secret: env.AUTH_SECRET, baseUrl: env.AUTH_URL });
    state.services = { auth: createAuthService(provider), workspace: createWorkspaceService(provider) };
  }
  return state.services;
}
