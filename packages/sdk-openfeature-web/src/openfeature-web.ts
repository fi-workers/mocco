// The public entry of @mocco/openfeature-web: an OpenFeature web provider for Mocco
// feature flags. It is OpenFeature's own OFREP web provider with Mocco's defaults: Mocco
// evaluates the flags (`POST /v1/ofrep/v1/evaluate/flags`, so rules and segment lists
// never reach the browser), the provider listens to the change stream the response
// advertises and re-fetches as soon as a flag changes, polls as a fallback, re-fetches
// when the tab becomes visible, and caches the last evaluation in localStorage so a
// reload renders flags before the network answers.
import { DEFAULT_BASE_URL, keyKindOf, MoccoKeyError, withoutTrailingSlashes } from '@mocco/sdk-core';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

import type { OFREPWebProviderOptions } from '@openfeature/ofrep-web-provider';
import type { Logger } from '@openfeature/web-sdk';

export interface MoccoWebProviderOptions extends Omit<
  OFREPWebProviderOptions,
  'baseUrl' | 'headers' | 'headersFactory'
> {
  /** A publishable key (`mk_pub_…`) with `flags:read`; it decides which environment is read. */
  publishableKey: string;
  baseUrl?: string;
}

/** The polling fallback: used while the change stream is unavailable (default 60 s). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

export class MoccoWebProvider extends OFREPWebProvider {
  override readonly metadata = { name: 'Mocco' };

  constructor(options: MoccoWebProviderOptions, logger?: Logger) {
    const { publishableKey, baseUrl, ...rest } = options;
    // Only publishable keys belong in a browser; Mocco shows them only the flags marked
    // "available to browsers and apps".
    if (keyKindOf(publishableKey) !== 'publishable') {
      throw new MoccoKeyError('Browsers use a publishable key (mk_pub_…) with flags:read');
    }
    super(
      {
        pollInterval: DEFAULT_POLL_INTERVAL_MS,
        ...rest,
        baseUrl: withoutTrailingSlashes(baseUrl ?? DEFAULT_BASE_URL),
        headers: [['Authorization', `Bearer ${publishableKey}`]],
      },
      logger,
    );
  }
}
