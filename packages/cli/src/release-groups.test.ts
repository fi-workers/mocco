import { OtaPlatforms } from '@mocco/common/ota-hosting';
import { describe, expect, it } from 'vitest';

import { releaseGroupsOf } from './release-groups';

import type { OtaPlatform } from '@mocco/common/ota-hosting';

const BOTH = [OtaPlatforms.ios, OtaPlatforms.android];

describe('releaseGroupsOf', () => {
  it('keeps platforms that share a runtime version in one release', async () => {
    const groups = await releaseGroupsOf(BOTH, async () => await Promise.resolve('5.5.0'));

    expect(groups).toEqual([{ runtimeVersion: '5.5.0', platforms: BOTH }]);
  });

  it('splits platforms that hash differently, as the fingerprint policy does', async () => {
    const fingerprints: Record<OtaPlatform, string> = { ios: 'ios-hash', android: 'android-hash' };

    const groups = await releaseGroupsOf(BOTH, async platform => await Promise.resolve(fingerprints[platform]));

    expect(groups).toEqual([
      { runtimeVersion: 'ios-hash', platforms: [OtaPlatforms.ios] },
      { runtimeVersion: 'android-hash', platforms: [OtaPlatforms.android] },
    ]);
  });

  it('resolves one platform at a time', async () => {
    const inFlight: number[] = [];
    let active = 0;

    await releaseGroupsOf(BOTH, async platform => {
      active += 1;
      inFlight.push(active);
      await Promise.resolve();
      active -= 1;
      return platform;
    });

    expect(inFlight).toEqual([1, 1]);
  });

  it('asks for each platform once', async () => {
    const asked: OtaPlatform[] = [];

    await releaseGroupsOf(BOTH, async platform => {
      asked.push(platform);
      return await Promise.resolve('1.0.0');
    });

    expect(asked).toEqual(BOTH);
  });
});
