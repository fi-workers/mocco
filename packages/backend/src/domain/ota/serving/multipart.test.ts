import { describe, expect, it } from 'vitest';

import { multipartOf } from '@backend/domain/ota/serving/multipart';

describe('multipartOf', () => {
  it('builds the protocol v1 body: the signed part with its expo-signature header, then extensions', () => {
    const { body, contentType } = multipartOf(
      'manifest',
      { id: 'u1', body: '{"id":"u1"}', signature: 'c2ln', keyid: 'root' },
      'b',
    );

    expect(contentType).toBe('multipart/mixed; boundary=b');
    expect(body).toBe(
      [
        '--b',
        'content-type: application/json; charset=utf-8',
        'content-disposition: form-data; name="manifest"',
        'expo-signature: sig="c2ln", keyid="root"',
        '',
        '{"id":"u1"}',
        '--b',
        'content-type: application/json',
        'content-disposition: form-data; name="extensions"',
        '',
        '{"assetRequestHeaders":{}}',
        '--b--',
        '',
      ].join('\r\n'),
    );
  });

  it('omits the signature header on an unsigned part', () => {
    const { body } = multipartOf('directive', { id: 'd', body: '{}', signature: null, keyid: null }, 'b');

    expect(body).toContain('name="directive"\r\n\r\n{}');
    expect(body).not.toContain('expo-signature');
  });
});
