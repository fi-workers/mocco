// The MCP endpoint's request handler — the public contract the frontend route mounts.
//
// `requireMcpAuth` verifies the bearer token against the authorization server's JWKS and
// checks it is audience-bound to our resource, so a token minted for another MCP server
// cannot be replayed here. It then hands over the token's claims; the subject is the
// person, and it is put into `authInfo.extra` because the SDK's `AuthInfo` describes the
// token rather than the user.
//
// Scopes are enforced in two places, each where it can be decided. The 401 that starts a
// connection names only the sign-in scopes, so a client never asks for `approvals:write`
// up front. The deciding tools declare `approvals:write` themselves (`scopeChallenge` in
// `tools/approvals.ts`), and the SDK answers a call to one with a 403
// `insufficient_scope` before the tool runs — judged on the parsed request it is about to
// execute, not on a header that merely names it. `mocco_monitors_check` does the same for
// `status:write`.
import { requireMcpAuth } from '@better-auth/mcp';
import { mcpSignInScopes } from '@mocco/common/mcp';

import { getMcpAuth } from '@backend/domain/auth/instance';
import { getMcpHandler } from '@backend/runtime/mcp';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

/** OAuth puts scopes in one space-separated string. */
function scopesOf(scope: unknown): string[] {
  if (typeof scope !== 'string') {
    return [];
  }
  // eslint-disable-next-line sonarjs/null-dereference -- split() yields strings, never null
  return scope.split(' ').filter(each => each !== '');
}

/** Serve one MCP request. POST only — see the route. */
export async function mcpHandler(request: Request): Promise<Response> {
  const { provider, mcpResource } = getMcpAuth();
  const guarded = requireMcpAuth(
    provider,
    async (authed, claims) =>
      await getMcpHandler().fetch(authed, {
        authInfo: {
          token: '',
          clientId: typeof claims.client_id === 'string' ? claims.client_id : '',
          scopes: scopesOf(claims.scope),
          // Lets a step-up challenge point the client at our protected-resource metadata.
          resource: new URL(mcpResource),
          extra: { [MCP_USER_ID]: claims.sub },
        },
      }),
    { resource: mcpResource, challengeScopes: mcpSignInScopes },
  );
  return await guarded(request);
}
