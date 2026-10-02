// Help center search for apps (#96): suggest the project's published help articles,
// e.g. on a contact screen while the user types. One GET per search; the key needs the
// help:read scope (a publishable key may hold it).
import { DEFAULT_BASE_URL, withoutTrailingSlashes } from './client';
import { MoccoError, MoccoNetworkError } from './errors';

export interface HelpArticleHit {
  title: string;
  /** The article's path on the help site (`/en/articles/…`). */
  path: string;
  /** The article's full address, when the help site's domain is known to Mocco. */
  url: string | null;
  /** Plain text around the match. */
  snippet: string;
}

export interface HelpSearchOptions {
  /** The reader's language; the source language where an article isn't translated. */
  locale?: string;
  limit?: number;
  /** `all` (default): every word must appear. `any`: one word is enough. */
  match?: 'all' | 'any';
}

export interface HelpClientOptions {
  /** A key with help:read (`mk_pub_…` in an app). */
  publishableKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class HelpClient {
  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HelpClientOptions) {
    this.baseUrl = `${withoutTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL)}/help`;
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  /**
   * Published articles matching `query`, best first, in `locale` where translated. Every
   * word must appear, or with `match: 'any'` (for free text such as an inquiry being
   * written) one word is enough and more matching words rank higher. An empty query
   * answers no hits without a request.
   */
  async search(query: string, opts: HelpSearchOptions = {}): Promise<HelpArticleHit[]> {
    // eslint-disable-next-line sonarjs/null-dereference -- query is a string, never null
    const trimmed = query.trim().slice(0, 500);
    if (trimmed === '') {
      return [];
    }
    const params = new URLSearchParams({ q: trimmed });
    if (opts.locale !== undefined) {
      params.set('locale', opts.locale);
    }
    if (opts.limit !== undefined) {
      params.set('limit', String(opts.limit));
    }
    if (opts.match !== undefined) {
      params.set('match', opts.match);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/search?${params.toString()}`, {
        headers: { authorization: `Bearer ${this.options.publishableKey}`, accept: 'application/json' },
      });
    } catch (error) {
      throw new MoccoNetworkError(`Couldn't reach Mocco at ${this.baseUrl}`, { cause: error });
    }
    if (!response.ok) {
      throw new MoccoError(response.status, { title: `Help search answered ${response.status}` });
    }
    const answer = (await response.json()) as { hits: HelpArticleHit[] };
    return answer.hits;
  }
}
