// OTA uploads from CI on the public /v1 surface (OTA design §6.2). A secret key with
// `ota:write` mints a short-lived upload session; the session token then declares a
// release, gets presigned PUTs for the missing assets, and finalizes it. Rejections are
// problem+json whose `detail` says exactly what to fix, so the CLI can print it as is.
import { ApiScopes } from '@mocco/common/apikey';
import { finalizeRequestSchema, uploadRequestSchema } from '@mocco/common/ota-hosting';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { KeyRateLimits, requireKey, type V1Deps, type V1Env } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { UploadSessionRow } from '@backend/domain/ota/repos/upload-session.repo';
import type { UploadService } from '@backend/domain/ota/UploadService';
import type { Context } from 'hono';
import type { z } from 'zod';

export interface OtaUploadDeps {
  uploads: Pick<UploadService, 'createSession' | 'authenticate' | 'beginRelease' | 'finalize'>;
}

interface SessionEnv {
  Variables: { session: UploadSessionRow };
}

const BEARER = 'Bearer ';

/** A domain error as problem+json; anything else is rethrown to the ext error handler. */
function problemOfError(error: unknown): Response {
  if (error instanceof BadRequestError) {
    return problemResponse(problemOf(400, ProblemCodes.uploadRejected, 'Upload rejected', error.message));
  }
  if (error instanceof NotFoundError) {
    return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found', error.message));
  }
  if (error instanceof ConflictError) {
    return problemResponse(problemOf(409, ProblemCodes.conflict, 'Conflict', error.message));
  }
  if (error instanceof ForbiddenError) {
    return problemResponse(problemOf(403, ProblemCodes.forbidden, 'Forbidden', error.message));
  }
  throw error;
}

/** The request's JSON body parsed by `schema`, or a 400 problem naming the first issue. */
async function parseJson<S extends z.ZodType>(
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

/** Authenticate `Authorization: Bearer mk_ups_…` and limit per session. */
const requireUploadSession = (deps: V1Deps, ota: OtaUploadDeps) =>
  createMiddleware<SessionEnv>(async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';

    const token = authorization.startsWith(BEARER) ? authorization.slice(BEARER.length).trim() : '';
    const session = token === '' ? undefined : await ota.uploads.authenticate(token);
    if (session === undefined) {
      return problemResponse(
        problemOf(401, ProblemCodes.invalidSession, 'The upload session is missing, invalid or expired'),
        { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      );
    }
    const result = await deps.limiter.consume(`ups:${session.id}`, KeyRateLimits.secret);
    if (!result.allowed) {
      return problemResponse(problemOf(429, ProblemCodes.rateLimited, 'Too many requests'));
    }
    c.set('session', session);
    await next();
    return undefined;
  });

export function createOtaUploadRoutes(deps: V1Deps, ota: OtaUploadDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();

  // Exchange a secret key for a 15-minute upload session bound to one app.
  app.post(
    '/apps/:appId/upload-sessions',
    requireKey(deps, { kinds: ['secret'], scope: ApiScopes.otaWrite }),
    async c => {
      try {
        const session = await ota.uploads.createSession(c.var.principal, c.req.param('appId'));
        return c.json(session, 201);
      } catch (error) {
        return problemOfError(error);
      }
    },
  );

  const sessions = new Hono<SessionEnv>();
  sessions.use('*', requireUploadSession(deps, ota));

  sessions.post('/', async c => {
    const { data, refused } = await parseJson(c, uploadRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    try {
      return c.json(await ota.uploads.beginRelease(c.var.session, data), 201);
    } catch (error) {
      return problemOfError(error);
    }
  });

  sessions.post('/:releaseId/finalize', async c => {
    const { data, refused } = await parseJson(c, finalizeRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    try {
      return c.json(await ota.uploads.finalize(c.var.session, c.req.param('releaseId'), data));
    } catch (error) {
      return problemOfError(error);
    }
  });

  app.route('/uploads', sessions);
  return app;
}
