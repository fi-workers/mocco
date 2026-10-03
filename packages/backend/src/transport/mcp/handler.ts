// The MCP endpoint's request handler — the public contract the frontend route mounts.
//
// `requireMcpAuth` verifies the bearer token against the authorization server's JWKS and
// checks it is audience-bound to our resource, so a token minted for another MCP server
// cannot be replayed here. It then hands over the token's claims; the subject is the
// person, and it is put into `authInfo.extra` because the SDK's `AuthInfo` describes the
// token rather than the user.
import { requireMcpAuth } from '@better-auth/mcp';

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
          extra: { [MCP_USER_ID]: claims.sub },
        },
      }),
    { resource: mcpResource },
  );
  return await guarded(request);
}
