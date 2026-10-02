// The public entry of @mocco/openfeature-web: an OpenFeature web provider for Mocco
// feature flags. It is OpenFeature's own OFREP web provider with Mocco's defaults: Mocco
// evaluates the flags (`POST /v1/ofrep/v1/evaluate/flags`, so rules and segment lists
// never reach the browser), the provider listens to the change stream the response
// advertises and re-fetches as soon as a flag changes, polls as a fallback, re-fetches
// when the tab becomes visible, and caches the last evaluation in localStorage so a
// reload renders flags before the network answers.
import {
  DEFAULT_BASE_URL,
  EvaluationCounter,
  keyKindOf,
  MoccoKeyError,
  TELEMETRY_PATH,
  withoutTrailingSlashes,
} from '@mocco/sdk-core';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
import { ErrorCode } from '@openfeature/web-sdk';

import type { OFREPWebProviderOptions } from '@openfeature/ofrep-web-provider';
import type { EvaluationContext, Hook, Logger } from '@openfeature/web-sdk';

export interface MoccoWebProviderOptions extends Omit<
  OFREPWebProviderOptions,
  'baseUrl' | 'headers' | 'headersFactory'
> {
  /** A publishable key (`mk_pub_…`) with `flags:read`; it decides which environment is read. */
  publishableKey: string;
  baseUrl?: string;
  /**
   * Send Mocco how often each flag was read, counted in the page and sent at most once a
   * minute and when the page is hidden (default on). Mocco uses it only to point out flags
   * nobody evaluates any more.
   */
  telemetry?: boolean;
}

/** The polling fallback: used while the change stream is unavailable (default 60 s). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

export class MoccoWebProvider extends OFREPWebProvider {
  private readonly counter: EvaluationCounter | undefined;

  private readonly flushWhenHidden = (): void => {
    if (document.visibilityState === 'hidden' && this.counter !== undefined) {
      // eslint-disable-next-line no-void -- an event callback can't await; flush() never rejects
      void this.counter.flush();
    }
  };

  override readonly metadata = { name: 'Mocco' };

  override readonly hooks: Hook[];

  constructor(options: MoccoWebProviderOptions, logger?: Logger) {
    const { publishableKey, baseUrl, telemetry, ...rest } = options;
    // Only publishable keys belong in a browser; Mocco shows them only the flags marked
    // "available to browsers and apps".
    if (keyKindOf(publishableKey) !== 'publishable') {
      throw new MoccoKeyError('Browsers use a publishable key (mk_pub_…) with flags:read');
    }
    const base = withoutTrailingSlashes(baseUrl ?? DEFAULT_BASE_URL);
    super(
      {
        pollInterval: DEFAULT_POLL_INTERVAL_MS,
        ...rest,
        baseUrl: base,
        headers: [['Authorization', `Bearer ${publishableKey}`]],
      },
      logger,
    );
    const fetchImpl = rest.fetchImplementation ?? fetch.bind(globalThis);
    const counter =
      (telemetry ?? true)
        ? new EvaluationCounter({
            send: async evaluations => {
              const response = await fetchImpl(`${base}${TELEMETRY_PATH}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json' },
                body: JSON.stringify({ evaluations }),
                // Lets the last report out while the page unloads.
                keepalive: true,
              });
              if (!response.ok) {
                throw new Error(`Mocco answered ${response.status}`);
              }
            },
          })
        : undefined;
    this.counter = counter;
    // Count each read; flags Mocco doesn't know are left out (it ignores them anyway).
    this.hooks =
      counter === undefined
        ? []
        : [
            {
              finally: (hookContext, details) => {
                if (details.errorCode !== ErrorCode.FLAG_NOT_FOUND) {
                  counter.record(hookContext.flagKey, details.variant ?? null);
                }
              },
            },
          ];
  }

  override async initialize(context?: EvaluationContext, domain?: string): Promise<void> {
    this.counter?.start();
    if (this.counter !== undefined && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.flushWhenHidden);
    }
    await super.initialize(context, domain);
  }

  override async onClose(): Promise<void> {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.flushWhenHidden);
    }
    await super.onClose?.();
    await this.counter?.stop();
  }
}
