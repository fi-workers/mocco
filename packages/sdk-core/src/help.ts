// A project's published help center for apps (#96, #216): suggest articles on a contact
// screen while the user types, list the collections and show an article in the app. The
// key needs the help:read scope (a publishable key may hold it).
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

/** What `GET /v1/help/search` answers. */
export interface HelpSearchResult {
  locale: string;
  hits: HelpArticleHit[];
}

/** An article in a listing. `id` is its stable short id; the slug is cosmetic. */
export interface HelpArticleEntry {
  id: string;
  slug: string;
  title: string;
  path: string;
  url: string | null;
}

export interface HelpCollection {
  slug: string;
  title: string;
  description: string | null;
  sections: { title: string; articles: HelpArticleEntry[] }[];
}

/** What `GET /v1/help/site` answers: the help center and what it publishes in `locale`. */
export interface HelpSite {
  name: string;
  sourceLocale: string;
  /** The languages it is translated into (the source not included). */
  locales: string[];
  /** The language served: the asked one when the site offers it, else the source. */
  locale: string;
  url: string | null;
  collections: HelpCollection[];
}

/** What `GET /v1/help/articles/:id` answers. */
export interface HelpArticle {
  id: string;
  slug: string;
  /** The language served: its translation where there is one, else the source. */
  locale: string;
  title: string;
  /** Markdown. */
  body: string;
  path: string;
  url: string | null;
  /** The languages this article is served in, the source first. */
  locales: string[];
  publishedAt: string | null;
  updatedAt: string | null;
}

export interface HelpReadOptions {
  /** The reader's language tag (`en-KR` counts as `en`); the source language where not translated. */
  locale?: string;
}

export interface HelpSearchOptions {
  /** The reader's language; the source language where an article isn't translated. */
  locale?: string;
  limit?: number;
  /** `all` (default): every word must appear. `any`: one word is enough. */
  match?: 'all' | 'any';
}

function localeParams(opts: HelpReadOptions): URLSearchParams {
  return new URLSearchParams(opts.locale === undefined ? {} : { locale: opts.locale });
}

/** "Was this helpful?" (`POST /v1/help/articles/:id/feedback`). */
export interface HelpFeedback {
  helpful: boolean;
  /** The language the reader read the article in. */
  locale?: string;
  /** Up to 500 characters, seen only by your team. */
  comment?: string;
}

/** What the feedback route sends: the answer and the reader's visitor id. */
export interface HelpFeedbackRequest extends HelpFeedback {
  visitorId?: string;
}

/** `counted` is false when this reader already answered today (the new answer replaced it). */
export interface HelpFeedbackResult {
  counted: boolean;
}

export interface HelpClientOptions {
  /** A key with help:read (`mk_pub_…` in an app). */
  publishableKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * An opaque id for this reader (8–64 letters, digits, `-` or `_`) that the app keeps, such
   * as an install id: Mocco counts one answer per reader, article and day, and stores only a
   * hash of it. Without one, the client makes a random id that lasts as long as it does.
   */
  visitorId?: string;
}

/** A random visitor id for a client without one (crypto when available). */
function randomVisitorId(): string {
  // Feature-detected: not every React Native runtime has Web Crypto.
  const webCrypto = Reflect.get(globalThis, 'crypto') as { randomUUID?: () => string } | undefined;
  if (webCrypto?.randomUUID !== undefined) {
    return webCrypto.randomUUID();
  }
  // eslint-disable-next-line sonarjs/pseudo-random -- a visitor id for counting votes, not a secret
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class HelpClient {
  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly visitorId: string;

  constructor(private readonly options: HelpClientOptions) {
    this.baseUrl = `${withoutTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL)}/help`;
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.visitorId = options.visitorId ?? randomVisitorId();
  }

  /** Call a /v1/help path (a GET, or a POST with `body`); null for a 404 when `missing` allows it. */
  private async get<T>(
    path: string,
    params: URLSearchParams,
    missing: 'null' | 'throw' = 'throw',
    body?: unknown,
  ): Promise<T | null> {
    const query = params.toString();
    const url = query === '' ? `${this.baseUrl}${path}` : `${this.baseUrl}${path}?${query}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.options.publishableKey}`,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new MoccoNetworkError(`Couldn't reach Mocco at ${this.baseUrl}`, { cause: error });
    }
    if (response.status === 404 && missing === 'null') {
      return null;
    }
    if (!response.ok) {
      let problem: { type?: string; title?: string; detail?: string };
      try {
        problem = (await response.json()) as typeof problem;
      } catch {
        problem = { title: `Help answered ${response.status}` };
      }
      throw new MoccoError(response.status, problem);
    }
    return (await response.json()) as T;
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
    const answer = await this.get<HelpSearchResult>('/search', params);
    return answer?.hits ?? [];
  }

  /** The help center's name and languages, and its published collections in `locale`. */
  async getSite(opts: HelpReadOptions = {}): Promise<HelpSite> {
    const site = await this.get<HelpSite>('/site', localeParams(opts));
    if (site === null) {
      throw new MoccoError(404, { title: 'This project has no help center' });
    }
    return site;
  }

  /** One published collection by its slug, or null when there is none. */
  async getCollection(slug: string, opts: HelpReadOptions = {}): Promise<HelpCollection | null> {
    const answer = await this.get<{ locale: string; collection: HelpCollection }>(
      `/collections/${encodeURIComponent(slug)}`,
      localeParams(opts),
      'null',
    );
    return answer?.collection ?? null;
  }

  /**
   * A published article by its id (or the `{id}-{slug}` ref from its path), or null when
   * it isn't published. `locale` on the answer says which language it is in.
   */
  async getArticle(id: string, opts: HelpReadOptions = {}): Promise<HelpArticle | null> {
    return await this.get<HelpArticle>(`/articles/${encodeURIComponent(id)}`, localeParams(opts), 'null');
  }

  /**
   * "Was this helpful?" for a published article. One answer per reader, article and day
   * is counted; answering again the same day replaces it (`counted: false`). Not retried.
   */
  async sendFeedback(id: string, feedback: HelpFeedback): Promise<HelpFeedbackResult> {
    const request: HelpFeedbackRequest = { ...feedback, visitorId: this.visitorId };
    const result = await this.get<HelpFeedbackResult>(
      `/articles/${encodeURIComponent(id)}/feedback`,
      new URLSearchParams(),
      'throw',
      request,
    );
    return result ?? { counted: false };
  }
}
