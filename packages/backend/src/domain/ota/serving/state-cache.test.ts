import { describe, expect, it } from 'vitest';

import { ChannelStateCache, headKeyOf } from '@backend/domain/ota/serving/state-cache';

import type { HeadState } from '@backend/domain/ota/serving/select';

const state = { rolloutBp: 0 } as HeadState;

describe('ChannelStateCache', () => {
  it('expires entries after the TTL, caches "nothing to serve", and evicts the least recently used', () => {
    let now = 0;
    const cache = new ChannelStateCache({ ttlMs: 5000, maxEntries: 2, now: () => now });
    cache.set('a', state);
    cache.set('b', null);

    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe(state);
    cache.set('c', state);
    expect(cache.get('b')).toBeUndefined();
    now = 5000;
    expect(cache.get('a')).toBeUndefined();
  });

  it("invalidates every head of one app's channel, and only that channel", () => {
    const cache = new ChannelStateCache();
    cache.set(headKeyOf('app', 'staging', 'ios', '1.0.0'), state);
    cache.set(headKeyOf('app', 'staging', 'android', '1.0.0'), state);
    cache.set(headKeyOf('app', 'staging-2', 'ios', '1.0.0'), state);

    cache.invalidateChannel('app', 'staging');

    expect(cache.get(headKeyOf('app', 'staging', 'ios', '1.0.0'))).toBeUndefined();
    expect(cache.get(headKeyOf('app', 'staging', 'android', '1.0.0'))).toBeUndefined();
    expect(cache.get(headKeyOf('app', 'staging-2', 'ios', '1.0.0'))).toBe(state);
  });
});
