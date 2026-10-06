// /api/ext/sites/:site/feedback (#175): what a public board page calls from the browser, on its
// site's own host. These are the /v1/feedback routes (transport/ext/v1/feedback.ts) behind the
// site instead of a key: the site's slug names the project, the way a publishable key with
// feedback:read and feedback:write would. Everything else is the same code: the public
// projection, the end-user token checks (a write still needs a token the app's server signed,
// or a confirmed email), and the per-end-user and per-address limits. It is not a versioned
// API: apps and widgets use /v1 with their key.
import { ApiKeyKinds, ApiScopes } from '@mocco/common/apikey';
import { createMiddleware } from 'hono/factory';

import { createFeedbackRoutes } from '@backend/transport/ext/v1/feedback';
import { ANONYMOUS_RATE_LIMIT, ipBucketOf, limit } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { FeedbackServingDeps } from '@backend/transport/ext/v1/feedback';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';
import type { Hono } from 'hono';

const SITE_SLUG = /^[a-z0-9-]{1,80}$/u;

export interface FeedbackSiteDeps {
  /** The project a public site serves (the help center's site, by its slug), or undefined. */
  projectOf: (site: string) => Promise<{ workspaceId: string; projectId: string } | undefined>;
}

export function createFeedbackSiteRoutes(
  deps: V1Deps,
  feedback: FeedbackServingDeps,
  sites: FeedbackSiteDeps,
): Hono<V1Env> {
  /** The site's project as the request's principal: a publishable key with both feedback scopes. */
  const site = createMiddleware<V1Env>(async (c, next) => {
    const limited = await limit(deps, `feedback:site:ip:${ipBucketOf(c)}`, ANONYMOUS_RATE_LIMIT);
    if (limited.refused !== undefined) {
      return limited.refused;
    }
    const slug = c.req.param('site') ?? '';
    const project = SITE_SLUG.test(slug) ? await sites.projectOf(slug) : undefined;
    if (project === undefined) {
      return problemResponse(problemOf(404, ProblemCodes.notFound, 'Not found'));
    }
    c.set('principal', {
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      keyId: `site:${slug}`,
      createdByUserId: null,
      kind: ApiKeyKinds.publishable,
      scopes: [ApiScopes.feedbackRead, ApiScopes.feedbackWrite],
      flagEnvironmentId: null,
    });
    await next();
    // The browser's own fresh copy: a page shows the count right after a vote.
    c.header('Cache-Control', 'no-store');
    return undefined;
  });
  return createFeedbackRoutes(deps, feedback, { read: site, write: site });
}
