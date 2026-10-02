// The public entry of @mocco/openfeature-react-native: an OpenFeature provider for Mocco
// feature flags in React Native apps (use it with @openfeature/react-sdk). Mocco evaluates
// the flags over OFREP (`POST /v1/ofrep/v1/evaluate/flags`), so rules and segment lists
// never ship in the app. The provider keeps the last evaluation in the app's storage
// (AsyncStorage) and serves it on the next launch before the network answers, or offline;
// it re-fetches when the app comes to the foreground, on a polling interval while active,
// and, given an EventSource implementation, as soon as Mocco's change stream says a flag
// changed. React Native has no localStorage, page visibility or EventSource, so the app
// passes those in.
import { DEFAULT_BASE_URL, keyKindOf, MoccoKeyError, withoutTrailingSlashes } from '@mocco/sdk-core';
import { ErrorCode, OpenFeatureEventEmitter, ProviderEvents, StandardResolutionReasons } from '@openfeature/web-sdk';

import type { EvaluationContext, FlagMetadata, JsonValue, Provider, ResolutionDetails } from '@openfeature/web-sdk';

/** The part of AsyncStorage the provider uses. */
export interface KeyValueStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

/** The part of React Native's `AppState` the provider uses. */
export interface AppStateLike {
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void };
}

/** The part of an EventSource (`react-native-sse`, or a browser's) the provider uses. */
export interface EventSourceLike {
  addEventListener(type: 'message', listener: (event: { data?: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  close(): void;
}

export type EventSourceConstructor = new (url: string) => EventSourceLike;

export interface MoccoReactNativeProviderOptions {
  /** A publishable key (`mk_pub_…`) with `flags:read`; it decides which environment is read. */
  publishableKey: string;
  baseUrl?: string;
  /** Where the last evaluation is kept between launches (pass AsyncStorage). */
  storage?: KeyValueStorage;
  /** Refresh on returning to the foreground, and pause polling in the background (pass AppState). */
  appState?: AppStateLike;
  /** Listen to Mocco's change stream with this EventSource implementation. */
  EventSource?: EventSourceConstructor;
  /** How often to re-fetch while the app is active (default 60 s; 0 turns polling off). */
  pollIntervalMs?: number;
  /** How long a stored evaluation may be served (default 30 days). */
  cacheTtlMs?: number;
  fetch?: typeof fetch;
}

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EVALUATE_PATH = '/ofrep/v1/evaluate/flags';
const STORAGE_PREFIX = 'mocco-flags:v1:';
/** Reconnect delays for the change stream: 1 s doubling to 30 s. */
const STREAM_RETRY_MS = 1000;
const STREAM_RETRY_MAX_MS = 30_000;

/** One flag of an OFREP bulk response. */
interface Evaluation {
  key: string;
  value?: unknown;
  variant?: string;
  reason?: string;
  errorCode?: string;
  errorDetails?: string;
  metadata?: FlagMetadata;
}

interface StoredEvaluation {
  etag: string | null;
  writtenAt: number;
  flags: Evaluation[];
}

interface BulkResponse {
  flags: Evaluation[];
  eventStreams?: { type: string; url?: string }[];
}

/** JSON with object keys sorted, so equal contexts give equal strings. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonical(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    // eslint-disable-next-line unicorn/no-array-sort -- a fresh array; older Hermes lacks toSorted
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    const members = entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** FNV-1a, twice with different seeds: a short, stable storage key (not a secret). */
function hash(text: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- text is a string, never null
  const codes = Array.from({ length: text.length }, (_, index) => text.codePointAt(index) ?? 0);
  const round = (seed: number) =>
    codes
      // eslint-disable-next-line no-bitwise -- FNV-1a is defined on 32-bit integers
      .reduce((h, code) => Math.imul(h ^ code, 0x01_00_01_93) >>> 0, seed)
      .toString(16)
      .padStart(8, '0');
  return round(0x81_1c_9d_c5) + round(0x05_0c_5d_1f);
}

const isType = (value: unknown, type: 'boolean' | 'string' | 'number' | 'object'): boolean =>
  type === 'object' ? value !== null && typeof value === 'object' : typeof value === type;

/** The keys whose evaluation differs between two bulk responses. */
function changedFlags(before: Map<string, Evaluation>, after: Map<string, Evaluation>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter(key => canonical(before.get(key) ?? null) !== canonical(after.get(key) ?? null));
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'Unknown error');

export class MoccoReactNativeProvider implements Provider {
  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly pollIntervalMs: number;

  private readonly cacheTtlMs: number;

  private flags = new Map<string, Evaluation>();

  private hasEvaluation = false;

  private etag: string | null = null;

  private context: EvaluationContext = {};

  /** Bumped on each context change, so a late answer for an old context is dropped. */
  private revision = 0;

  private inFlight: Promise<void> | undefined;

  /** A refresh was asked for while one ran: run once more after it. */
  private isRefreshQueued = false;

  /** Stale (serving an old evaluation) or errored: the next good fetch emits READY. */
  private isDegraded = false;

  private isActive = true;

  private isClosed = false;

  private timer: ReturnType<typeof setInterval> | undefined;

  private appStateSubscription: { remove: () => void } | undefined;

  private stream: EventSourceLike | undefined;

  private streamUrl: string | undefined;

  private streamFailures = 0;

  private streamRetry: ReturnType<typeof setTimeout> | undefined;

  readonly metadata = { name: 'Mocco' } as const;

  readonly runsOn = 'client' as const;

  readonly events = new OpenFeatureEventEmitter();

  constructor(private readonly options: MoccoReactNativeProviderOptions) {
    // An app ships its key to every device, so only publishable keys belong here; Mocco
    // shows them only the flags marked "available to browsers and apps".
    if (keyKindOf(options.publishableKey) !== 'publishable') {
      throw new MoccoKeyError('Apps use a publishable key (mk_pub_…) with flags:read');
    }
    this.baseUrl = withoutTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  private storageKey(context: EvaluationContext): string {
    return STORAGE_PREFIX + hash([this.baseUrl, this.options.publishableKey, canonical(context)].join('\n'));
  }

  /** The stored evaluation for a context, if fresh enough; storage failures read as none. */
  private async load(context: EvaluationContext): Promise<StoredEvaluation | undefined> {
    try {
      const text = await this.options.storage?.getItem(this.storageKey(context));
      if (text === undefined || text === null) {
        return undefined;
      }
      const stored = JSON.parse(text) as StoredEvaluation;
      return Date.now() - stored.writtenAt <= this.cacheTtlMs && Array.isArray(stored.flags) ? stored : undefined;
    } catch {
      return undefined;
    }
  }

  private async save(context: EvaluationContext, flags: Evaluation[]): Promise<void> {
    const stored: StoredEvaluation = { etag: this.etag, writtenAt: Date.now(), flags };
    try {
      await this.options.storage?.setItem(this.storageKey(context), JSON.stringify(stored));
    } catch {
      // A full or failing storage only costs the offline copy.
    }
  }

  private adopt(flags: Evaluation[]): string[] {
    const next = new Map(flags.map(flag => [flag.key, flag]));
    const changed = changedFlags(this.flags, next);
    this.flags = next;
    this.hasEvaluation = true;
    return changed;
  }

  /** One bulk evaluation for the current context. */
  private async fetchOnce(isInitial: boolean): Promise<void> {
    const { revision, context } = this;
    // Without a live stream, skip If-None-Match: only a full answer carries a fresh stream URL.
    const etag = this.options.EventSource !== undefined && this.stream === undefined ? null : this.etag;
    const response = await this.fetchImpl(`${this.baseUrl}${EVALUATE_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.publishableKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(etag !== null && { 'if-none-match': etag }),
      },
      body: JSON.stringify({ context }),
    });
    if (revision !== this.revision) {
      return;
    }
    if (response.status === 304) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Mocco answered ${response.status}`);
    }
    const body = (await response.json()) as BulkResponse;
    this.etag = response.headers.get('etag');
    const changed = this.adopt(body.flags);
    await this.save(context, body.flags);
    if (!isInitial && changed.length > 0) {
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: changed });
    }
    const url = body.eventStreams?.find(stream => stream.type === 'sse')?.url;
    if (url !== undefined) {
      this.connect(url);
    }
  }

  /** Fetch, coalescing overlapping calls. Rejects only when `isInitial` (initialize decides). */
  private async refresh({ isInitial = false }: { isInitial?: boolean } = {}): Promise<void> {
    if (this.inFlight !== undefined) {
      this.isRefreshQueued = true;
      await this.inFlight;
      return;
    }
    const run = async (): Promise<void> => {
      try {
        await this.fetchOnce(isInitial);
        if (this.isDegraded) {
          this.isDegraded = false;
          this.events.emit(ProviderEvents.Ready);
        }
      } catch (error) {
        if (isInitial) {
          throw error;
        }
        if (!this.isDegraded) {
          this.isDegraded = true;
          this.events.emit(this.hasEvaluation ? ProviderEvents.Stale : ProviderEvents.Error, {
            message: errorText(error),
          });
        }
      }
    };
    this.inFlight = run();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
    if (this.isRefreshQueued && !this.isClosed) {
      this.isRefreshQueued = false;
      await this.refresh();
    }
  }

  private connect(url: string): void {
    const EventSourceImpl = this.options.EventSource;
    if (EventSourceImpl === undefined || !this.isActive || this.isClosed) {
      return;
    }
    if (this.stream !== undefined && this.streamUrl === url) {
      return;
    }
    this.disconnect();
    const stream = new EventSourceImpl(url);
    this.stream = stream;
    this.streamUrl = url;
    stream.addEventListener('message', event => {
      this.streamFailures = 0;
      try {
        const message = JSON.parse(String(event.data)) as { type?: unknown };
        if (message.type === 'refetchEvaluation') {
          // eslint-disable-next-line no-void -- an event callback can't await; refresh() never rejects
          void this.refresh();
        }
      } catch {
        // Not an OFREP event: ignore it.
      }
    });
    // Mocco closes each stream after a few minutes and its URL expires after an hour, so
    // on any error: drop it, and re-fetch (a full answer, with a fresh URL) after a backoff.
    stream.addEventListener('error', () => {
      if (this.stream !== stream) {
        return;
      }
      this.disconnect();
      const delay = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_MS * 2 ** Math.min(this.streamFailures, 5));
      this.streamFailures += 1;
      this.streamRetry = setTimeout(() => {
        // eslint-disable-next-line no-void -- a timer callback can't await; refresh() never rejects
        void this.refresh();
      }, delay);
    });
  }

  private disconnect(): void {
    clearTimeout(this.streamRetry);
    this.streamRetry = undefined;
    this.stream?.close();
    this.stream = undefined;
    this.streamUrl = undefined;
  }

  private startPolling(): void {
    if (this.pollIntervalMs <= 0 || this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      // eslint-disable-next-line no-void -- a timer callback can't await; refresh() never rejects
      void this.refresh();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Foreground: re-fetch and resume; background: stop polling and close the stream. */
  private onAppStateChange(state: string): void {
    const isActive = state === 'active';
    if (isActive === this.isActive) {
      return;
    }
    this.isActive = isActive;
    if (isActive) {
      this.startPolling();
      // eslint-disable-next-line no-void -- an event callback can't await; refresh() never rejects
      void this.refresh();
    } else {
      this.stopPolling();
      this.disconnect();
    }
  }

  private resolve<T>(
    flagKey: string,
    type: 'boolean' | 'string' | 'number' | 'object',
    defaultValue: T,
  ): ResolutionDetails<T> {
    if (!this.hasEvaluation) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.PROVIDER_NOT_READY,
        errorMessage: 'Mocco flags have not loaded yet',
      };
    }
    const flag = this.flags.get(flagKey);
    if (flag === undefined) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.FLAG_NOT_FOUND,
        errorMessage: `No flag "${flagKey}" for this key`,
      };
    }
    const flagMetadata = flag.metadata ?? {};
    if (flag.errorCode !== undefined) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: flag.errorCode as ErrorCode,
        ...(flag.errorDetails !== undefined && { errorMessage: flag.errorDetails }),
        flagMetadata,
      };
    }
    // A disabled flag carries no value: the app's default applies.
    if (flag.value === undefined) {
      return {
        value: defaultValue,
        reason: flag.reason ?? StandardResolutionReasons.DEFAULT,
        flagMetadata,
      };
    }
    if (!isType(flag.value, type)) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.TYPE_MISMATCH,
        errorMessage: `Flag "${flagKey}" is not a ${type}`,
        flagMetadata,
      };
    }
    return {
      value: flag.value as T,
      reason: flag.reason ?? StandardResolutionReasons.STATIC,
      flagMetadata,
      ...(flag.variant !== undefined && { variant: flag.variant }),
    };
  }

  /**
   * Serve the stored evaluation for this context at once if there is one (and refresh in
   * the background); otherwise wait for Mocco. Fails only with neither.
   */
  async initialize(context: EvaluationContext = {}): Promise<void> {
    this.context = context;
    this.appStateSubscription ??= this.options.appState?.addEventListener('change', state => {
      this.onAppStateChange(state);
    });
    this.startPolling();
    const stored = await this.load(context);
    if (stored === undefined) {
      await this.refresh({ isInitial: true });
      return;
    }
    this.adopt(stored.flags);
    this.etag = stored.etag;
    // eslint-disable-next-line no-void -- runs in the background; refresh() never rejects here
    void this.refresh();
  }

  /** Re-evaluate for the new context (the stored copy first, if any). */
  async onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> {
    this.revision += 1;
    this.context = newContext;
    const stored = await this.load(newContext);
    this.flags = new Map(stored?.flags.map(flag => [flag.key, flag]));
    this.hasEvaluation = stored !== undefined;
    this.etag = stored?.etag ?? null;
    if (stored === undefined) {
      await this.refresh({ isInitial: true });
    } else {
      await this.refresh();
    }
  }

  async onClose(): Promise<void> {
    this.isClosed = true;
    this.stopPolling();
    this.disconnect();
    this.appStateSubscription?.remove();
    this.appStateSubscription = undefined;
    await Promise.resolve();
  }

  // eslint-disable-next-line unicorn/consistent-boolean-name -- the OpenFeature Provider interface names it
  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean): ResolutionDetails<boolean> {
    return this.resolve(flagKey, 'boolean', defaultValue);
  }

  resolveStringEvaluation(flagKey: string, defaultValue: string): ResolutionDetails<string> {
    return this.resolve(flagKey, 'string', defaultValue);
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number): ResolutionDetails<number> {
    return this.resolve(flagKey, 'number', defaultValue);
  }

  resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T): ResolutionDetails<T> {
    return this.resolve(flagKey, 'object', defaultValue);
  }
}
