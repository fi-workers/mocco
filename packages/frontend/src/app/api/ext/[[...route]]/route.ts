// The external inbound surface (ADR 0011): a Hono app on the App Router, kept
// separate from the internal tRPC (Pages Router). App-Router handlers get the
// raw fetch Request — required for webhook HMAC verification (slice 3b).
// This is the only `app/` file; the Pages-Router UI is unchanged.
import { extHandler } from '@mocco/backend/ext/app';

export const GET = async (request: Request): Promise<Response> => await extHandler(request);
export const POST = async (request: Request): Promise<Response> => await extHandler(request);
