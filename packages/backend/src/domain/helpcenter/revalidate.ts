// Refreshing a help center's public pages right after a change (#96). The pages are ISR
// (ADR 0015) and refresh themselves within HELP_REVALIDATE_SECONDS; with a revalidator,
// a publish, unpublish, delete or new translation also asks Next to rebuild the pages it
// touched at once: the site's home in every language and the article in every language.
// Other pages (whose list now shows a new title) still catch up within the minute.
import { createHash, timingSafeEqual } from 'node:crypto';

import { articlePath } from '@mocco/common/help';
import { z } from 'zod';

import { HelpSiteRepo } from '@backend/domain/helpcenter/repos/site.repo';

import type { Db } from '@backend/infra/db/types';

/** Rebuilds public pages by their internal path (`/_sites/<slug>/…`). */
export interface HelpPageRevalidator {
  revalidate(paths: readonly string[]): Promise<void>;
}

export interface RevalidatedArticle {
  shortId: string;
  slug: string;
}

/** The pages a change to `article` (or to the site, without one) shows on. */
export function helpPagePaths(
  site: { slug: string; sourceLocale: string; locales: readonly string[] },
  article?: RevalidatedArticle,
): string[] {
  const root = `/_sites/${site.slug}`;
  const locales = [site.sourceLocale, ...site.locales.filter(locale => locale !== site.sourceLocale)];
  return [
    root,
    ...locales.map(locale => `${root}/${locale}`),
    ...(article === undefined
      ? []
      : locales.map(locale => `${root}${articlePath(locale, article.shortId, article.slug)}`)),
  ];
}

export class HelpRevalidation {
  constructor(private readonly deps: { db: Db; revalidator?: HelpPageRevalidator }) {}

  /** Refresh the pages `article` shows on. Never throws: the pages catch up on their own. */
  async article(workspaceId: string, projectId: string, article: RevalidatedArticle): Promise<void> {
    const { revalidator } = this.deps;
    if (revalidator === undefined) {
      return;
    }
    try {
      const site = await new HelpSiteRepo(this.deps.db).find(workspaceId, projectId);
      if (site !== undefined) {
        await revalidator.revalidate(helpPagePaths(site, article));
      }
    } catch (error) {
      console.warn(`[help] couldn't refresh the public pages: ${String(error)}`);
    }
  }
}

const MAX_PATHS = 50;

const revalidateBodySchema = z.object({
  paths: z
    .array(
      z
        .string()
        .max(300)
        .regex(/^\/_sites\/[a-z0-9-]+(?:\/[A-Za-z0-9-]+)*$/u),
    )
    .min(1)
    .max(MAX_PATHS),
});

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Why a caller is refused: no secret configured (503) or not the right bearer (401). */
function refusalOf(authorization: string | undefined, secrets: readonly string[]): 401 | 503 | undefined {
  if (secrets.length === 0) {
    return 503;
  }
  const [scheme, token, ...rest] = (authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || token === undefined || rest.length > 0) {
    return 401;
  }
  const presented = digest(token);
  return secrets.some(secret => timingSafeEqual(presented, digest(secret))) ? undefined : 401;
}

/**
 * Checks a call to `/api/help/revalidate`: the bearer must be one of `secrets` and the
 * paths must be help site pages. Status 200 carries the paths to rebuild.
 */
export function checkRevalidateRequest(
  authorization: string | undefined,
  body: unknown,
  secrets: readonly string[],
): { status: 200 | 400 | 401 | 503; paths: string[] } {
  const refusal = refusalOf(authorization, secrets);
  const parsed = revalidateBodySchema.safeParse(body);
  if (refusal !== undefined || !parsed.success) {
    return { status: refusal ?? 400, paths: [] };
  }
  return { status: 200, paths: parsed.data.paths };
}
