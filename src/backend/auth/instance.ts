// Production composition root — the one place the app DB binds to the auth
// service. Lazy so builds don't need env (AUTH_SECRET) at import time.
import { getEnv } from '../config/env';
import { getDb } from '../db/client';

import { createAuthService, type AuthService } from './service';

const state: { auth?: AuthService } = {};

export function getAuth(): AuthService {
  if (!state.auth) {
    const env = getEnv();
    state.auth = createAuthService(getDb(), { secret: env.AUTH_SECRET, baseUrl: env.AUTH_URL });
  }
  return state.auth;
}
