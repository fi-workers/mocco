// Production composition root — the one place the app DB binds to the vendor
// provider and the services wrap it. Lazy so builds don't need env at import.
import { getEnv } from '../config/env';
import { getDb } from '../db/client';
import { MoccoConfigParser } from '../pipeline/MoccoConfigParser';
import { PipelineService } from '../pipeline/PipelineService';
import { decodeYaml } from '../pipeline/yaml/decode';

import { AuthService } from './AuthService';
import { createProvider } from './provider';
import { WorkspaceService } from './WorkspaceService';

export interface Services {
  auth: AuthService;
  workspace: WorkspaceService;
  pipeline: PipelineService;
}

const state: { services?: Services } = {};

export function getServices(): Services {
  if (!state.services) {
    const env = getEnv();
    const provider = createProvider(getDb(), { secret: env.AUTH_SECRET, baseUrl: env.AUTH_URL });
    state.services = {
      auth: new AuthService(provider),
      workspace: new WorkspaceService(provider),
      pipeline: new PipelineService(getDb(), new MoccoConfigParser(decodeYaml)),
    };
  }
  return state.services;
}
