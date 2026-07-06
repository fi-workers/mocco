// The ONLY frontend file that imports the auth vendor's client. Everything else
// uses the neutral names exported here (mirrors src/backend/auth/provider.ts).
import { createAuthClient } from 'better-auth/react';

// baseURL omitted — the auth routes live on the same origin (/api/auth).
const client = createAuthClient();

export const { useSession } = client;

export async function signUp(input: { email: string; password: string; name: string }) {
  return await client.signUp.email(input);
}

export async function signIn(input: { email: string; password: string }) {
  return await client.signIn.email(input);
}

export async function signOut() {
  return await client.signOut();
}
