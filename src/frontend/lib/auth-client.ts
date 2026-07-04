// The ONLY frontend file that imports the auth vendor's client. Everything else
// uses the neutral names exported here (mirrors src/backend/auth/provider.ts).
import { createAuthClient } from 'better-auth/react';

// baseURL omitted — the auth routes live on the same origin (/api/auth).
const client = createAuthClient();

export const { useSession } = client;

export function signUp(input: { email: string; password: string; name: string }) {
  return client.signUp.email(input);
}

export function signIn(input: { email: string; password: string }) {
  return client.signIn.email(input);
}

export function signOut() {
  return client.signOut();
}
