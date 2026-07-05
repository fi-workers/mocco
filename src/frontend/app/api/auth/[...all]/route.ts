// Mounts the backend's vendor-neutral auth handler. No auth-vendor import here.
import { getAuth } from '@mocco/backend/auth/instance';

const handler = (request: Request): Promise<Response> => getAuth().handler(request);
export { handler as GET, handler as POST };
