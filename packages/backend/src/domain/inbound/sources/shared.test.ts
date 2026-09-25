import { NeutralMessageLimits, neutralMessageSchema, Severities } from '@mocco/common/notification';
import { describe, expect, it } from 'vitest';

import {
  buildMessage,
  isValidHmacHex,
  parseJson,
  stripPrefix,
  truncate,
  withHttps,
} from '@backend/domain/inbound/sources/shared';
import { hmacHex } from '@backend/domain/inbound/testing/fixtures';

describe('isValidHmacHex', () => {
  const body = '{"a":1}';

  it('accepts a matching lowercase or uppercase hex digest', () => {
    const hex = hmacHex('sha256', 'sek', body);
    expect(isValidHmacHex('sha256', 'sek', body, hex)).toBe(true);
    expect(isValidHmacHex('sha256', 'sek', body, hex.toUpperCase())).toBe(true);
  });

  it('rejects a digest of another body, another secret, or another length', () => {
    const hex = hmacHex('sha256', 'sek', body);
    expect(isValidHmacHex('sha256', 'sek', '{"a":2}', hex)).toBe(false);
    expect(isValidHmacHex('sha256', 'other', body, hex)).toBe(false);
    expect(isValidHmacHex('sha256', 'sek', body, hex.slice(0, -2))).toBe(false);
    expect(isValidHmacHex('sha1', 'sek', body, hex)).toBe(false);
  });

  it('rejects an empty secret or an empty signature', () => {
    expect(isValidHmacHex('sha256', '', body, hmacHex('sha256', '', body))).toBe(false);
    expect(isValidHmacHex('sha256', 'sek', body, '')).toBe(false);
  });
});

describe('stripPrefix and withHttps', () => {
  it('strips a present prefix only', () => {
    expect(stripPrefix('refs/heads/main', 'refs/heads/')).toBe('main');
    expect(stripPrefix('refs/tags/v1', 'refs/heads/')).toBeUndefined();
  });

  it('adds https to a bare host only', () => {
    expect(withHttps('app.vercel.app')).toBe('https://app.vercel.app');
    expect(withHttps('https://x.test/a')).toBe('https://x.test/a');
  });
});

describe('parseJson', () => {
  it('returns the value, or undefined for malformed JSON', () => {
    expect(parseJson('{"a":1}')).toStrictEqual({ a: 1 });
    expect(parseJson('{not json')).toBeUndefined();
    expect(parseJson('')).toBeUndefined();
  });
});

describe('truncate', () => {
  it('keeps short text and cuts long text to the limit with an ellipsis', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abcdef', 4)).toHaveLength(4);
  });

  it('never splits a surrogate pair', () => {
    expect(truncate('ab😀cd', 4)).toBe('ab…');
    expect(truncate('ab😀cd', 5)).toBe('ab😀…');
  });
});

describe('buildMessage', () => {
  it('truncates every part to the NeutralMessage limits and drops empty optionals', () => {
    const message = buildMessage({
      title: 'x'.repeat(1000),
      url: undefined,
      description: 'y'.repeat(5000),
      severity: Severities.info,
      fields: Array.from({ length: 15 }, (_, index) => ({ name: `f${index}`, value: 'v'.repeat(2000) })),
      footer: 'Footer',
    });
    expect(message.title).toHaveLength(NeutralMessageLimits.title);
    expect(message.description).toHaveLength(NeutralMessageLimits.description);
    expect(message.fields).toHaveLength(NeutralMessageLimits.fields);
    expect(message.fields[0]?.value).toHaveLength(NeutralMessageLimits.fieldValue);
    expect('url' in message).toBe(false);
    expect(neutralMessageSchema.parse(message)).toStrictEqual(message);
  });

  it('drops a non-http url, an empty description, and empty field values', () => {
    const message = buildMessage({
      title: 'T',
      url: 'ftp://example.com/file',
      description: '',
      severity: Severities.error,
      fields: [{ name: 'Empty', value: '' }],
      footer: 'F',
    });
    expect(message).toStrictEqual({ title: 'T', severity: 'error', fields: [], footer: 'F' });
  });
});
