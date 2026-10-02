import { describe, expect, it } from 'vitest';

import { rolloutBucket, selectResponse } from '@backend/domain/ota/serving/select';

import type { HeadState, SignedPart } from '@backend/domain/ota/serving/select';

const part = (id: string): SignedPart => ({ id, body: `{"id":"${id}"}`, signature: 'c2ln', keyid: 'root' });

const head = (overrides: Partial<HeadState> = {}): HeadState => ({
  active: part('active'),
  candidate: null,
  rolloutBp: 0,
  rolloutSalt: 'salt',
  isPaused: false,
  directive: null,
  ...overrides,
});

/** A client id whose bucket is below (or not below) `bp`. */
function clientIn(bp: number, isInside: boolean): string {
  const ids = Array.from({ length: 500 }, (_, index) => `device-${index}`);
  const found = ids.find(id => rolloutBucket('salt', id) < bp === isInside);
  if (found === undefined) {
    throw new Error('no such client in the sample');
  }
  return found;
}

describe('selectResponse', () => {
  it('is a noop without a head, or when the device already runs the target', () => {
    expect(selectResponse({ head: undefined, clientId: 'a', currentUpdateId: undefined })).toEqual({ kind: 'noop' });
    expect(selectResponse({ head: head(), clientId: 'a', currentUpdateId: 'active' })).toEqual({ kind: 'noop' });
    expect(selectResponse({ head: head({ active: null }), clientId: 'a', currentUpdateId: undefined })).toEqual({
      kind: 'noop',
    });
  });

  it('serves the active update, and a directive over anything else', () => {
    expect(selectResponse({ head: head(), clientId: 'a', currentUpdateId: 'old' })).toEqual({
      kind: 'update',
      part: part('active'),
    });
    const directive = part('directive');
    expect(selectResponse({ head: head({ directive }), clientId: 'a', currentUpdateId: 'active' })).toEqual({
      kind: 'directive',
      part: directive,
    });
  });

  it('serves the candidate to devices in the rollout, but not when paused or without a client id', () => {
    const rolling = head({ candidate: part('candidate'), rolloutBp: 5000 });
    const inside = clientIn(5000, true);
    const outside = clientIn(5000, false);

    expect(selectResponse({ head: rolling, clientId: inside, currentUpdateId: undefined })).toMatchObject({
      part: { id: 'candidate' },
    });
    expect(selectResponse({ head: rolling, clientId: outside, currentUpdateId: undefined })).toMatchObject({
      part: { id: 'active' },
    });
    expect(selectResponse({ head: rolling, clientId: undefined, currentUpdateId: undefined })).toMatchObject({
      part: { id: 'active' },
    });
    expect(
      selectResponse({ head: { ...rolling, isPaused: true }, clientId: inside, currentUpdateId: undefined }),
    ).toMatchObject({ part: { id: 'active' } });
    // A device already on the candidate keeps it while paused (it is its current update).
    expect(
      selectResponse({ head: { ...rolling, isPaused: true }, clientId: inside, currentUpdateId: 'active' }),
    ).toEqual({ kind: 'noop' });
  });

  it('buckets devices stably and roughly evenly', () => {
    expect(rolloutBucket('salt', 'device-1')).toBe(rolloutBucket('salt', 'device-1'));
    const buckets = Array.from({ length: 2000 }, (_, index) => rolloutBucket('salt', `d${index}`));
    const share = buckets.filter(bucket => bucket < 2500).length / buckets.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
  });
});
