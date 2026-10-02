import { OtaPlatforms } from '@mocco/common/ota-hosting';
import { describe, expect, it } from 'vitest';

import { fingerprintCommandOf, parseFingerprint } from './fingerprint';

describe('fingerprintCommandOf', () => {
  it('asks the project Expo CLI for the platform the build will ask for', () => {
    expect(fingerprintCommandOf(OtaPlatforms.android)).toEqual({
      command: 'npx',
      args: ['expo-updates', 'fingerprint:generate', '--platform', 'android'],
    });
  });

  it('names one platform at a time, because the two hash differently', () => {
    const ios = fingerprintCommandOf(OtaPlatforms.ios);
    const android = fingerprintCommandOf(OtaPlatforms.android);

    expect(ios.args).not.toEqual(android.args);
    expect(ios.args.filter(arg => arg === '--platform')).toHaveLength(1);
  });
});

describe('parseFingerprint', () => {
  it('takes the hash out of the fingerprint, ignoring the sources beside it', () => {
    const output = JSON.stringify({
      sources: [{ type: 'file', filePath: '.gitignore', hash: 'irrelevant' }],
      hash: '2fbd15bc78f4575f19475d3cf953880ce9e29447',
    });

    expect(parseFingerprint(output, OtaPlatforms.ios)).toBe('2fbd15bc78f4575f19475d3cf953880ce9e29447');
  });

  it('says what to fix when the CLI printed something that is not JSON', () => {
    expect(() => parseFingerprint('expo-updates: command not found\n', OtaPlatforms.ios)).toThrow(
      /didn't print JSON for ios/u,
    );
  });

  it('says what to fix when the JSON carries no hash', () => {
    expect(() => parseFingerprint(JSON.stringify({ sources: [] }), OtaPlatforms.android)).toThrow(
      /printed no hash for android/u,
    );
  });

  it('refuses an empty hash rather than publishing under one', () => {
    expect(() => parseFingerprint(JSON.stringify({ hash: '' }), OtaPlatforms.ios)).toThrow(/printed no hash/u);
  });
});
