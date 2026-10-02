// OTA from CI on the public /v1 surface (OTA design §6.2). A secret key with `ota:write`
// mints a short-lived upload session (the session token then declares a release, gets
// presigned PUTs for the missing assets, and finalizes it), reads a release's status and
// promotes ready releases to unprotected channels. Rejections are
// problem+json whose `detail` says exactly what to fix, so the CLI can print it as is.
import { ApiScopes } from '@mocco/common/apikey';
import {
  ChannelPolicyOutcomes,
  finalizeRequestSchema,
  oidcExchangeRequestSchema,
  promotionRequestSchema,
  rolloutBpOf,
  stopActionSchema,
  stopRequestSchema,
  uploadRequestSchema,
} from '@mocco/common/ota-hosting';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { OidcExchangeDeniedError } from '@backend/domain/ota/errors';
import {
  KeyRateLimits,
  limitAnonymous,
  requireKey,
  type V1Deps,
  type V1Env,
} from '@backend/transport/ext/v1/middleware';
import { parseJson, problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { OtaChannelService } from '@backend/domain/ota/OtaChannelService';
import type { UploadSessionRow } from '@backend/domain/ota/repos/upload-session.repo';
import type { TrustPolicyService } from '@backend/domain/ota/TrustPolicyService';
import type { UploadService } from '@backend/domain/ota/UploadService';
import type { PromotionResult } from '@mocco/common/ota-hosting';

export interface OtaUploadDeps {
  uploads: Pick<UploadService, 'createSession' | 'authenticate' | 'beginRelease' | 'finalize'>;
  channels: Pick<
    OtaChannelService,
    | 'promoteAsKey'
    | 'releaseStatusAsKey'
    | 'promoteAsSession'
    | 'releaseStatusAsSession'
    | 'stopAsKey'
    | 'promotionState'
    | 'requireKeyApp'
  >;
  trustPolicies: Pick<TrustPolicyService, 'exchange'>;
}

interface SessionEnv {
  Variables: { session: UploadSessionRow };
}

const BEARER = 'Bearer ';

/** 201 when heads changed, 202 when a protected channel's approval is pending, 200 for a no-op. */
function statusOfPromotion(result: PromotionResult): 200 | 201 | 202 {
  if (result.outcome === ChannelPolicyOutcomes.pendingApproval) {
    return 202;
  }
  return result.changed ? 201 : 200;
}

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

  // Trusted publishing: a GitHub Actions OIDC token for a 15-minute session. Every
  // refusal is the same 403 (the reason is logged and audited, never returned).
  app.post('/auth/oidc', limitAnonymous(deps), async c => {
    const { data, refused } = await parseJson(c, oidcExchangeRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    try {
      return c.json(await ota.trustPolicies.exchange(data.appId, data.token), 201);
    } catch (error) {
      if (error instanceof OidcExchangeDeniedError) {
        return problemResponse(problemOf(403, ProblemCodes.forbidden, 'OIDC token not accepted'));
      }
      throw error;
    }
  });

  const ciKey = requireKey(deps, { kinds: ['secret'], scope: ApiScopes.otaWrite });

  // A release's status, so CI can wait for `ready` before promoting.
  app.get('/apps/:appId/releases/:releaseId', ciKey, async c => {
    try {
      return c.json(
        await ota.channels.releaseStatusAsKey(c.var.principal, c.req.param('appId'), c.req.param('releaseId')),
      );
    } catch (error) {
      return problemOfError(error);
    }
  });

  // Promote a ready release to an unprotected channel.
  app.post('/apps/:appId/releases/:releaseId/promotions', ciKey, async c => {
    const { data, refused } = await parseJson(c, promotionRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    try {
      const result = await ota.channels.promoteAsKey(
        c.var.principal,
        c.req.param('appId'),
        c.req.param('releaseId'),
        data.channel,
        { reason: data.reason, rolloutBp: rolloutBpOf(data.rolloutPercent) },
      );
      return c.json(result, statusOfPromotion(result));
    } catch (error) {
      return problemOfError(error);
    }
  });

  // Stop actions from CI — never gated: pause a rollout, roll back, or roll back to embedded.
  const stopPaths = { pause: 'pause', rollback: 'rollback', 'rollback-to-embedded': 'rollback_embedded' } as const;
  app.post('/apps/:appId/channels/:channel/:action{pause|rollback|rollback-to-embedded}', ciKey, async c => {
    const action = stopActionSchema.parse(stopPaths[c.req.param('action') as keyof typeof stopPaths]);
    const { data, refused } = await parseJson(c, stopRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    try {
      return c.json(
        await ota.channels.stopAsKey(c.var.principal, c.req.param('appId'), c.req.param('channel'), action, data),
        201,
      );
    } catch (error) {
      return problemOfError(error);
    }
  });

  // A promotion request's state, so CI can wait for its approval (`promote --wait`).
  app.get('/apps/:appId/promotions/:requestId', ciKey, async c => {
    try {
      const appRow = await ota.channels.requireKeyApp(c.var.principal, c.req.param('appId'));
      return c.json(await ota.channels.promotionState(appRow.id, c.req.param('requestId')));
    } catch (error) {
      return problemOfError(error);
    }
  });

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

  sessions.get('/:releaseId', async c => {
    try {
      return c.json(await ota.channels.releaseStatusAsSession(c.var.session, c.req.param('releaseId')));
    } catch (error) {
      return problemOfError(error);
    }
  });

  // Promote the session's release (within a trust policy's channels).
  sessions.post('/:releaseId/promotions', async c => {
    const { data, refused } = await parseJson(c, promotionRequestSchema);
    if (refused !== undefined) {
      return refused;
    }
    try {
      const result = await ota.channels.promoteAsSession(c.var.session, c.req.param('releaseId'), data.channel, {
        reason: data.reason,
        rolloutBp: rolloutBpOf(data.rolloutPercent),
      });
      return c.json(result, statusOfPromotion(result));
    } catch (error) {
      return problemOfError(error);
    }
  });

  sessions.get('/:releaseId/promotions/:requestId', async c => {
    try {
      return c.json(await ota.channels.promotionState(c.var.session.appId, c.req.param('requestId')));
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
