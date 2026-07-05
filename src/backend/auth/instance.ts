// Production composition root — the one place the app DB binds to the auth
// service. Lazy so builds don't need env (AUTH_SECRET) at import time.
import { db } from '../db/client';

import { createAuthService, type AuthService } from './service';

const state: { auth?: AuthService } = {};

export function getAuth(): AuthService {
  state.auth ??= createAuthService(db, {
    secret: process.env.AUTH_SECRET,
    baseUrl: process.env.AUTH_URL,
  });
  return state.auth;
}
