// The public entry of @mocco/openfeature-server: an OpenFeature server provider that
// evaluates Mocco feature flags locally (ADR 0024). It polls the key's environment
// ruleset (`GET /v1/flags/ruleset`, If-None-Match), so an evaluation is a pure in-memory
// lookup with no network call, and it keeps serving the last good ruleset when Mocco is
// unreachable (emitting PROVIDER_STALE until a poll succeeds again).
import { parseRuleset, resolveTyped } from '@mocco/flags-core';
import { MoccoClient } from '@mocco/sdk-core';
import { ErrorCode, OpenFeatureEventEmitter, ProviderEvents, StandardResolutionReasons } from '@openfeature/server-sdk';

import type { FlagValueType, Ruleset } from '@mocco/flags-core';
import type { EvaluationContext, JsonValue, Provider, ResolutionDetails } from '@openfeature/server-sdk';

export interface MoccoProviderOptions {
  /** A secret key (`mk_sec_…`) with `flags:read`; it decides which environment is read. */
  secretKey: string;
  baseUrl?: string;
  /** How often to poll for a new ruleset (default 30 s, at least 1 s). */
  pollIntervalMs?: number;
  /** A ruleset document to serve until the first successful poll (e.g. one baked into the build). */
  bootstrap?: unknown;
  fetch?: typeof fetch;
}

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 1000;
const RULESET_PATH = '/flags/ruleset';

/** The keys whose definitions differ between two rulesets. */
function changedFlags(before: Ruleset | null, after: Ruleset): string[] {
  const keys = new Set([...Object.keys(before?.flags ?? {}), ...Object.keys(after.flags)]);
  return [...keys].filter(
    key => JSON.stringify(before?.flags[key] ?? null) !== JSON.stringify(after.flags[key] ?? null),
  );
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'Unknown error');

export class MoccoProvider implements Provider {
  private readonly client: MoccoClient;

  private readonly pollIntervalMs: number;

  private ruleset: Ruleset | null = null;

  private etag: string | null = null;

  private timer: ReturnType<typeof setInterval> | undefined;

  /** Stale (serving an old ruleset) or errored (no ruleset): the next good poll emits READY. */
  private isDegraded = false;

  private isPolling = false;

  readonly metadata = { name: 'Mocco' } as const;

  readonly runsOn = 'server' as const;

  readonly events = new OpenFeatureEventEmitter();

  constructor(options: MoccoProviderOptions) {
    this.client = new MoccoClient({
      key: options.secretKey,
      isBrowser: false,
      // A failed poll is retried by the next one, not by backing off inside it.
      maxRetries: 0,
      ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    });
    this.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    if (options.bootstrap !== undefined) {
      const check = parseRuleset(options.bootstrap);
      if (!check.ok) {
        throw new Error(`The bootstrap ruleset is invalid: ${check.errors.join('; ')}`);
      }
      this.ruleset = check.ruleset;
    }
  }

  /** Local evaluation: no I/O. */
  private resolve<T>(
    flagKey: string,
    type: FlagValueType,
    defaultValue: T,
    context: EvaluationContext,
  ): ResolutionDetails<T> {
    if (this.ruleset === null) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.PROVIDER_NOT_READY,
        errorMessage: 'The Mocco ruleset has not loaded yet',
      };
    }
    const resolution = resolveTyped(this.ruleset, flagKey, type, defaultValue, context);
    return {
      value: resolution.value,
      reason: resolution.reason,
      flagMetadata: resolution.flagMetadata,
      ...(resolution.variant !== undefined && { variant: resolution.variant }),
      ...(resolution.errorCode !== undefined && { errorCode: resolution.errorCode as ErrorCode }),
      ...(resolution.errorMessage !== undefined && { errorMessage: resolution.errorMessage }),
    };
  }

  private startPolling(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      // eslint-disable-next-line no-void -- a timer callback can't await; poll() never rejects
      void this.poll({ isInitial: false });
    }, this.pollIntervalMs);
    // Polling never keeps the process alive on its own.
    this.timer.unref();
  }

  /** One poll. Never rejects: resolves with the failure's message, if any. */
  private async poll({ isInitial }: { isInitial: boolean }): Promise<string | undefined> {
    if (this.isPolling) {
      return undefined;
    }
    this.isPolling = true;
    try {
      const result = await this.client.getIfChanged<unknown>(RULESET_PATH, this.etag);
      if (result.modified) {
        const check = parseRuleset(result.body);
        if (!check.ok) {
          // Keep serving the last good ruleset; don't adopt its ETag, so the next poll refetches.
          throw new Error(`Mocco served an invalid ruleset: ${check.errors.join('; ')}`);
        }
        const flagsChanged = changedFlags(this.ruleset, check.ruleset);
        this.ruleset = check.ruleset;
        this.etag = result.etag;
        if (!isInitial && flagsChanged.length > 0) {
          this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged });
        }
      }
      if (this.isDegraded) {
        this.isDegraded = false;
        this.events.emit(ProviderEvents.Ready);
      }
      return undefined;
    } catch (error) {
      const message = errorText(error);
      if (isInitial) {
        // A bootstrap keeps the provider READY; without one, initialize() rejects (ERROR).
        this.isDegraded = this.ruleset === null;
      } else if (!this.isDegraded) {
        this.isDegraded = true;
        this.events.emit(this.ruleset === null ? ProviderEvents.Error : ProviderEvents.Stale, { message });
      }
      return message;
    } finally {
      this.isPolling = false;
    }
  }

  /** Fetch the ruleset (READY), then keep polling. Without a ruleset (no bootstrap, and
   * Mocco unreachable) initialization fails, and polling keeps trying to recover. */
  async initialize(): Promise<void> {
    this.startPolling();
    const error = await this.poll({ isInitial: true });
    if (error !== undefined && this.ruleset === null) {
      throw new Error(`Couldn't load the Mocco ruleset: ${error}`);
    }
  }

  async onClose(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.resolve();
  }

  // eslint-disable-next-line unicorn/consistent-boolean-name -- the OpenFeature Provider interface names it
  async resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext) {
    return await Promise.resolve(this.resolve(flagKey, 'boolean', defaultValue, context));
  }

  async resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext) {
    return await Promise.resolve(this.resolve(flagKey, 'string', defaultValue, context));
  }

  async resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext) {
    return await Promise.resolve(this.resolve(flagKey, 'number', defaultValue, context));
  }

  async resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context: EvaluationContext) {
    return await Promise.resolve(this.resolve(flagKey, 'object', defaultValue, context));
  }
}
