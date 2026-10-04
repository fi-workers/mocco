// RFC 8414 authorization-server metadata. The issuer is `<origin>/api/auth`, so a client
// looks for it at `/.well-known/oauth-authorization-server/api/auth` — at the origin's
// root, outside the /api/auth mount. The auth handler serves it; this route only lets the
// request reach it. See the protected-resource route next to it.
import { getServices } from '@mocco/backend/auth/instance';

export const GET = async (request: Request): Promise<Response> => await getServices().auth.handler(request);
export const HEAD = async (request: Request): Promise<Response> => await getServices().auth.handler(request);
