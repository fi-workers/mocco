// /v1/help (#96): search a project's published help center, e.g. to suggest articles on
// an app's contact screen. Read-only and published content only, so publishable keys
// may call it (scope help:read).
import { ApiScopes } from '@mocco/common/apikey';
import { Hono } from 'hono';
import { z } from 'zod';

import { requireKey } from '@backend/transport/ext/v1/middleware';
import { problemOf, problemResponse, ProblemCodes } from '@backend/transport/ext/v1/problem';

import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import type { V1Deps, V1Env } from '@backend/transport/ext/v1/middleware';

export interface HelpServingDeps {
  help: Pick<HelpPublicReadService, 'searchInProject'>;
  /** The site's public origin, for absolute article URLs; null when not served. */
  originOf: (slug: string) => string | null;
}

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  /** Any language tag (`en`, `en-KR`, `zh-Hant-TW`): its language is served where offered. */
  locale: z
    .string()
    .max(35)
    .regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/u)
    // eslint-disable-next-line sonarjs/null-dereference -- zod hands the transform a string
    .transform(tag => tag.split(/[-_]/u, 1)[0]?.toLowerCase() ?? '')
    .optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  /** `any`: one word is enough, for free text such as an inquiry being written. */
  match: z.enum(['all', 'any']).default('all'),
});

export function createHelpRoutes(deps: V1Deps, help: HelpServingDeps): Hono<V1Env> {
  const app = new Hono<V1Env>();

  app.get('/search', requireKey(deps, { scope: ApiScopes.helpRead }), async c => {
    const query = searchQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return problemResponse(problemOf(400, ProblemCodes.badRequest, 'q is required (1–500 characters)'));
    }
    const { workspaceId, projectId } = c.var.principal;
    try {
      const result = await help.help.searchInProject(
        workspaceId,
        projectId,
        query.data.locale ?? '',
        query.data.q,
        query.data.limit,
        query.data.match,
      );
      const origin = help.originOf(result.slug);
      c.header('Cache-Control', 'public, max-age=60');
      return c.json({
        locale: result.locale,
        hits: result.hits.map(hit => ({ ...hit, url: origin === null ? null : `${origin}${hit.path}` })),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'HelpSiteNotFoundError') {
        return problemResponse(problemOf(404, ProblemCodes.notFound, 'This project has no help center'));
      }
      throw error;
    }
  });

  return app;
}
