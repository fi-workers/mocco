// RFC 9728 protected-resource metadata for the MCP endpoint. An MCP client that gets a
// 401 from /api/mcp is pointed here (`/.well-known/oauth-protected-resource/api/mcp`) to
// learn which authorization server issues tokens for it. Without this route discovery
// stops at a 404 and no client can sign in.
//
// The document is served by the auth handler, which answers the root `.well-known` paths
// itself. They just never reached it, because the auth routes are mounted under /api/auth.
import { getServices } from '@mocco/backend/auth/instance';

export const GET = async (request: Request): Promise<Response> => await getServices().auth.handler(request);
export const HEAD = async (request: Request): Promise<Response> => await getServices().auth.handler(request);
