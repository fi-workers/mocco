// The public entry of @mocco/js (the package's "exports" target). Product features join
// as subpath exports (`@mocco/js/flags`, …) as they ship.
import { HelpClient, MoccoClient } from '@mocco/sdk-core';

import type { HelpClientOptions, WhoAmI } from '@mocco/sdk-core';

export interface MoccoJsOptions {
  /** A publishable key (`mk_pub_…`). The page's origin must be one of the project's web origins. */
  publishableKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface MoccoJs {
  client: MoccoClient;
  /** Check the key's configuration: which project and scopes it speaks for. */
  whoami(): Promise<WhoAmI>;
}

/** Create the browser client. Refuses a secret key: Mocco rejects those from a browser. */
export function createMocco(options: MoccoJsOptions): MoccoJs {
  const client = new MoccoClient({
    key: options.publishableKey,
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
  return { client, whoami: async () => await client.whoami() };
}

/**
 * The project's published help center (needs a key with help:read): search it, list its
 * collections and show an article on the page. Create it once.
 */
export function createHelp(options: HelpClientOptions): HelpClient {
  return new HelpClient(options);
}

export { HelpClient, MoccoError, MoccoKeyError, MoccoNetworkError } from '@mocco/sdk-core';
export type {
  HelpArticle,
  HelpArticleEntry,
  HelpArticleHit,
  HelpClientOptions,
  HelpCollection,
  HelpReadOptions,
  HelpSearchOptions,
  HelpSite,
  WhoAmI,
} from '@mocco/sdk-core';
