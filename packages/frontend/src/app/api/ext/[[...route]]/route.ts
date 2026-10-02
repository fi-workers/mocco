// The external inbound surface (ADR 0011): a Hono app on the App Router, kept
// separate from the internal tRPC (Pages Router). App-Router handlers get the
// raw fetch Request — required for webhook HMAC verification (slice 3b).
// This is the only `app/` file; the Pages-Router UI is unchanged.
import { extHandler } from '@mocco/backend/ext/app';

// Vercel function limit for the ext surface, in seconds. The job tick runs here and must
// finish inside it; keep it equal to JobTiming.functionMaxDurationMs in
// packages/backend/src/domain/jobs/policy.ts (a backend test checks). Must be a literal.
export const maxDuration = 300;

export const GET = async (request: Request): Promise<Response> => await extHandler(request);
export const POST = async (request: Request): Promise<Response> => await extHandler(request);
// Uploads to the filesystem storage driver's signed URLs (transport/ext/storage.ts).
export const PUT = async (request: Request): Promise<Response> => await extHandler(request);
export const HEAD = async (request: Request): Promise<Response> => await extHandler(request);
// CORS preflights for browser SDKs. Without this export Next.js answers OPTIONS itself,
// with no Access-Control-* headers, and every cross-origin call fails.
export const OPTIONS = async (request: Request): Promise<Response> => await extHandler(request);
