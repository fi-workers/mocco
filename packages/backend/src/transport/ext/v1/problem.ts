// RFC 9457 problem details for the public /v1 surface (ADR 0017): a stable `type` URI per
// error code, a short `title`, the HTTP `status`, and an optional `detail`. Never vendor
// or SQL detail.
import type { Context } from 'hono';
import type { z } from 'zod';

export const ProblemCodes = {
  missingKey: 'missing_key',
  invalidKey: 'invalid_key',
  secretKeyFromBrowser: 'secret_key_from_browser',
  originNotAllowed: 'origin_not_allowed',
  wrongKeyKind: 'wrong_key_kind',
  insufficientScope: 'insufficient_scope',
  rateLimited: 'rate_limited',
  badRequest: 'bad_request',
  notFound: 'not_found',
  conflict: 'conflict',
  forbidden: 'forbidden',
  invalidSession: 'invalid_session',
  uploadRejected: 'upload_rejected',
  identityNotVerified: 'identity_not_verified',
  contactBlocked: 'contact_blocked',
  guestsNotAllowed: 'guests_not_allowed',
  invalidLocationToken: 'invalid_location_token',
  subscriptionsUnavailable: 'subscriptions_unavailable',
  missingEndUserToken: 'missing_end_user_token',
  invalidEndUserToken: 'invalid_end_user_token',
} as const;
export type ProblemCode = (typeof ProblemCodes)[keyof typeof ProblemCodes];

export const PROBLEM_TYPE_BASE = 'https://mocco.dev/problems/';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

export function problemOf(status: number, code: ProblemCode, title: string, detail?: string): Problem {
  return { type: `${PROBLEM_TYPE_BASE}${code}`, title, status, ...(detail !== undefined && { detail }) };
}

export function problemResponse(problem: Problem, headers: Record<string, string> = {}): Response {
  return Response.json(problem, {
    status: problem.status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE, ...headers },
  });
}

/** The request's JSON body parsed by `schema`, or a 400 problem naming the first issue. */
export async function parseJson<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ data: z.output<S>; refused?: undefined } | { data?: undefined; refused: Response }> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return { refused: problemResponse(problemOf(400, ProblemCodes.badRequest, 'The body must be JSON')) };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) {
    return { data: parsed.data };
  }
  const [issue] = parsed.error.issues;
  const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  return {
    refused: problemResponse(
      problemOf(400, ProblemCodes.badRequest, 'Invalid request', `${where}${issue?.message ?? 'invalid'}`),
    ),
  };
}
