// The ONLY frontend file that imports the auth vendor's client. Everything else
// uses the neutral names exported here (mirrors src/backend/auth/provider.ts).
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { createAuthClient } from 'better-auth/react';

// baseURL omitted — the auth routes live on the same origin (/api/auth).
//
// `oauthProviderClient` matters when an MCP client sends someone here to sign in: the
// authorization server puts a signed copy of its request in this page's query string,
// and the plugin sends it along with the sign-in (or sign-up, or consent) call. That is
// how the server knows to resume the authorization afterwards instead of just starting a
// session. The answer then carries a redirect, which the client follows by itself.
const client = createAuthClient({ plugins: [oauthProviderClient()] });

export const { useSession } = client;

/** What a sign-in or sign-up came back with. `isRedirecting` means the server sent the
 * browser on (an authorization in progress), so the caller must not navigate itself. */
interface AuthResult {
  error: { message?: string } | null;
  isRedirecting: boolean;
}

const isRedirect = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && 'redirect' in data && data.redirect === true;

export async function signUp(input: { email: string; password: string; name: string }): Promise<AuthResult> {
  const { data, error } = await client.signUp.email(input);
  return { error, isRedirecting: isRedirect(data) };
}

export async function signIn(input: { email: string; password: string }): Promise<AuthResult> {
  const { data, error } = await client.signIn.email(input);
  return { error, isRedirecting: isRedirect(data) };
}

export async function signOut() {
  return await client.signOut();
}

/** The public face of an app asking to act as the signed-in person: its name and links. */
export async function getAuthorizingApp(clientId: string) {
  const { data, error } = await client.$fetch<{ client_id: string; client_name?: string; client_uri?: string }>(
    '/oauth2/public-client',
    { method: 'GET', query: { client_id: clientId } },
  );
  return error ? null : data;
}

/** Answer the consent screen. The server replies with a redirect back to the app (with a
 * code, or with `access_denied`), which the client follows. */
export async function answerConsent(isAccepted: boolean) {
  const { error } = await client.$fetch('/oauth2/consent', { method: 'POST', body: { accept: isAccepted } });
  return { error };
}
