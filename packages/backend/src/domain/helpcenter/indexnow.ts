// Telling search engines a help article changed (#367), through IndexNow: Bing (which feeds
// ChatGPT search and Copilot), Naver, Yandex and Seznam recrawl the URLs they're sent
// instead of waiting for the sitemap. Google doesn't take part; it reads the sitemap's
// lastmod. Each site proves it owns its host with a key served at `/indexnow.txt`; the key
// is derived from AUTH_SECRET and the site's slug, so nothing is stored.
import { createHmac } from 'node:crypto';

import { HelpSiteRepo } from '@backend/domain/helpcenter/repos/site.repo';
import { helpPagePaths } from '@backend/domain/helpcenter/revalidate';

import type { RevalidatedArticle } from '@backend/domain/helpcenter/revalidate';
import type { Db } from '@backend/infra/db/types';

/** Sends one IndexNow submission. */
export interface IndexNowSender {
  submit(submission: { host: string; key: string; keyLocation: string; urls: readonly string[] }): Promise<void>;
}

/** Where a site serves its key. */
export const INDEXNOW_KEY_PATH = '/indexnow.txt';

/** A site's IndexNow key: 32 hex characters, the same on every deploy with the same secret. */
export function indexNowKey(secret: string, slug: string): string {
  return createHmac('sha256', secret).update(`mocco-indexnow:${slug}`).digest('hex').slice(0, 32);
}

export class HelpIndexNow {
  constructor(
    private readonly deps: {
      db: Db;
      secret: string;
      /** The site's canonical origin (custom domain first), or null when sites aren't served. */
      originOf: (slug: string) => string | null;
      sender: IndexNowSender;
    },
  ) {}

  /** Submit the pages a change to `article` shows on: each language's home and the article. */
  async submitArticle(workspaceId: string, projectId: string, article: RevalidatedArticle): Promise<void> {
    const site = await new HelpSiteRepo(this.deps.db).find(workspaceId, projectId);
    const origin = site === undefined ? null : this.deps.originOf(site.slug);
    if (site === undefined || origin === null) {
      return;
    }
    const root = `/_sites/${site.slug}`;
    const urls = helpPagePaths(site, article)
      .filter(path => path !== root)
      // eslint-disable-next-line sonarjs/null-dereference -- a path string, never null
      .map(path => `${origin}${path.slice(root.length)}`);
    await this.deps.sender.submit({
      host: new URL(origin).host,
      key: indexNowKey(this.deps.secret, site.slug),
      keyLocation: `${origin}${INDEXNOW_KEY_PATH}`,
      urls,
    });
  }
}
