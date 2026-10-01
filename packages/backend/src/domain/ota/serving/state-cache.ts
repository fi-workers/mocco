// The manifest endpoint's in-process cache (OTA design §6.1): each serving state is kept
// for a few seconds, so a burst of devices checking for updates costs one query per head.
// A promotion in this process invalidates its heads at once; other instances catch up
// within the TTL.
import type { HeadState } from '@backend/domain/ota/serving/select';

/** What a lookup resolved to: the head, or `null` for "nothing to serve" (also cached). */
export type CachedHead = HeadState | null;

interface Entry {
  value: CachedHead;
  expiresAt: number;
}

export const DEFAULT_STATE_TTL_MS = 5000;
export const DEFAULT_STATE_CACHE_SIZE = 5000;

export const headKeyOf = (appId: string, channel: string, platform: string, runtimeVersion: string) =>
  JSON.stringify([appId, channel, platform, runtimeVersion]);

/** A small LRU with a TTL. Map iteration order is insertion order, so the first key is the oldest. */
export class ChannelStateCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {}

  private nowMs(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The cached value, or undefined on a miss (absent or expired). sonarjs/function-return-type
   * is a false positive: every branch returns the declared `CachedHead | undefined`. */
  // eslint-disable-next-line sonarjs/function-return-type
  get(key: string): CachedHead | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= this.nowMs()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert: most recently used last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: CachedHead): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.nowMs() + (this.opts.ttlMs ?? DEFAULT_STATE_TTL_MS) });
    const max = this.opts.maxEntries ?? DEFAULT_STATE_CACHE_SIZE;
    if (this.entries.size > max) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) {
        this.entries.delete(oldest.value);
      }
    }
  }

  /** Drop every cached head of an app's channel (after a change to it). */
  invalidateChannel(appId: string, channel: string): void {
    const prefix = JSON.stringify([appId, channel]).slice(0, -1);
    this.entries.forEach((_, key) => {
      // eslint-disable-next-line sonarjs/null-dereference -- Map keys here are strings, never null
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    });
  }
}
