import { describe, expect, it } from 'vitest';

import { selfApiUrlOf, selfWidgetsConfigOf } from './mocco-self';
import { selfEndUserTokenSchema } from './mocco-self-token';

describe('selfWidgetsConfigOf', () => {
  it('is null, so the console shows no widget, without a key or a board', () => {
    const missing = [
      {},
      { publishableKey: 'mk_pub_abc' },
      { board: 'mocco' },
      { publishableKey: '', board: 'mocco' },
      { publishableKey: 'mk_pub_abc', board: ' '.repeat(3) },
    ].map(raw => selfWidgetsConfigOf(raw));
    expect(missing).toEqual([null, null, null, null, null]);
  });

  it('is null for an API URL that is not a URL', () => {
    expect(selfWidgetsConfigOf({ publishableKey: 'mk_pub_abc', board: 'mocco', apiUrl: 'api.mocco.club' })).toBeNull();
  });

  it('takes the key and board, trimmed, and leaves an empty API URL to the page origin', () => {
    const config = selfWidgetsConfigOf({ publishableKey: ' mk_pub_abc ', board: 'mocco', apiUrl: '' });
    expect(config).toEqual({ publishableKey: 'mk_pub_abc', board: 'mocco', apiUrl: undefined });
    expect(config && selfApiUrlOf(config, 'https://www.mocco.club')).toBe('https://www.mocco.club/api/ext/v1');
  });

  it('uses a set API URL as is', () => {
    const config = selfWidgetsConfigOf({
      publishableKey: 'mk_pub_abc',
      board: 'mocco',
      apiUrl: 'https://api.mocco.club/v1',
    });
    expect(config && selfApiUrlOf(config, 'https://www.mocco.club')).toBe('https://api.mocco.club/v1');
  });
});

describe('selfEndUserTokenSchema', () => {
  it('reads the token route answer and refuses anything else', () => {
    expect(selfEndUserTokenSchema.safeParse({ token: 'a.b.c', expiresAt: '2026-10-17T10:10:00.000Z' }).success).toBe(
      true,
    );
    expect(selfEndUserTokenSchema.safeParse({ token: '', expiresAt: 'soon' }).success).toBe(false);
  });
});
