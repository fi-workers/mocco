// Mounts the backend's vendor-neutral auth handler. No auth-vendor import here.
import { getServices } from '@mocco/backend/auth/instance';

const handler = (request: Request): Promise<Response> => getServices().auth.handler(request);
export { handler as GET, handler as POST };
