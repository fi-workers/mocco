import { OtaPlatforms } from '@mocco/common/ota-hosting';
import { describe, expect, it } from 'vitest';

import { exportCommandOf } from './expo-export';

describe('exportCommandOf', () => {
  it('names every platform it was asked for', () => {
    expect(exportCommandOf([OtaPlatforms.ios, OtaPlatforms.android], 'dist')).toEqual({
      command: 'npx',
      args: ['expo', 'export', '--platform', 'ios', '--platform', 'android', '--output-dir', 'dist'],
    });
  });

  it('never passes "all", which would export web on a project that targets it', () => {
    const { args } = exportCommandOf([OtaPlatforms.ios, OtaPlatforms.android], 'dist');

    expect(args).not.toContain('all');
    expect(args).not.toContain('web');
  });

  it('exports one platform alone when only one was asked for', () => {
    expect(exportCommandOf([OtaPlatforms.android], 'out').args).toEqual([
      'expo',
      'export',
      '--platform',
      'android',
      '--output-dir',
      'out',
    ]);
  });
});
