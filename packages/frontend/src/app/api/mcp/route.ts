// The MCP endpoint (ADR 0011, ADR 0025): external inbound, so the App Router, where the
// handler gets the raw fetch Request.
//
// POST only. The 2026-07-28 revision is stateless — there is no session to open or
// terminate — so GET and DELETE are not operations here, and Next.js answering them with
// a 405 by omission is exactly right.
import { mcpHandler } from '@mocco/backend/mcp/handler';

export const POST = async (request: Request): Promise<Response> => await mcpHandler(request);
