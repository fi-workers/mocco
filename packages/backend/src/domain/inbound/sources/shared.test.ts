import {
  NeutralMessageLimits,
  neutralMessageLength,
  neutralMessageSchema,
  Severities,
} from '@mocco/common/notification';
import { describe, expect, it } from 'vitest';

import {
  buildMessage,
  decodeBody,
  ignored,
  isValidHmacHex,
  mapped,
  nonEmpty,
  ownValue,
  parseJson,
  sanitize,
  stripPrefix,
  truncate,
  withHttps,
} from '@backend/domain/inbound/sources/shared';
import { encode, expectPostgresSafe, hmacHex } from '@backend/domain/inbound/testing/fixtures';

const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

describe('isValidHmacHex', () => {
  const body = encode('{"a":1}');

  it('accepts a matching lowercase or uppercase hex digest', () => {
    const hex = hmacHex('sha256', 'sek', body);
    expect(isValidHmacHex('sha256', 'sek', body, hex)).toBe(true);
    expect(isValidHmacHex('sha256', 'sek', body, hex.toUpperCase())).toBe(true);
  });

  it('rejects a digest of another body, another secret, or another algorithm', () => {
    const hex = hmacHex('sha256', 'sek', body);
    expect(isValidHmacHex('sha256', 'sek', encode('{"a":2}'), hex)).toBe(false);
    expect(isValidHmacHex('sha256', 'other', body, hex)).toBe(false);
    expect(isValidHmacHex('sha1', 'sek', body, hex)).toBe(false);
  });

  it('requires exactly the digest length in hex', () => {
    const hex = hmacHex('sha256', 'sek', body);
    expect(isValidHmacHex('sha256', 'sek', body, `${hex}a`)).toBe(false);
    expect(isValidHmacHex('sha256', 'sek', body, `${hex}00`)).toBe(false);
    expect(isValidHmacHex('sha256', 'sek', body, hex.slice(0, -1))).toBe(false);
    expect(isValidHmacHex('sha256', 'sek', body, hex.slice(0, -2))).toBe(false);
    expect(isValidHmacHex('sha256', 'sek', body, `${hex.slice(0, -1)}g`)).toBe(false);
  });

  it('rejects an empty secret or an empty signature', () => {
    expect(isValidHmacHex('sha256', '', body, hmacHex('sha256', '', body))).toBe(false);
    expect(isValidHmacHex('sha256', 'sek', body, '')).toBe(false);
  });

  it('signs the exact bytes, including a UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(isValidHmacHex('sha256', 'sek', withBom, hmacHex('sha256', 'sek', withBom))).toBe(true);
    expect(isValidHmacHex('sha256', 'sek', withBom, hmacHex('sha256', 'sek', body))).toBe(false);
  });
});

describe('decodeBody', () => {
  it('decodes UTF-8 and strips a leading BOM', () => {
    expect(decodeBody(encode('{"a":"ü"}'))).toBe('{"a":"ü"}');
    expect(decodeBody(new Uint8Array([0xef, 0xbb, 0xbf, ...encode('{}')]))).toBe('{}');
  });

  it('is undefined for invalid UTF-8', () => {
    expect(decodeBody(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeUndefined();
    expect(decodeBody(new Uint8Array([0xed, 0xa0, 0x80]))).toBeUndefined();
  });
});

describe('sanitize', () => {
  it('removes NUL and replaces lone surrogates, keeping valid pairs', () => {
    expect(sanitize('a\u{0}b')).toBe('ab');
    expect(sanitize('a\u{D800}b')).toBe('a�b');
    expect(sanitize('a\u{DC00}b')).toBe('a�b');
    expect(sanitize('😀\u{D83D}')).toBe('😀�');
    expect(sanitize('plain 😀 text')).toBe('plain 😀 text');
  });

  it.each(['\u{D800}', '\u{DFFF}\u{D800}', 'x😀y', '\u{DE00}\u{D83D}', 'ok'])(
    'matches String.prototype.toWellFormed for %j',
    sample => {
      const wellFormed = (sample as unknown as { toWellFormed: () => string }).toWellFormed();
      expect(sanitize(sample)).toBe(wellFormed);
    },
  );
});

describe('stripPrefix, withHttps and nonEmpty', () => {
  it('strips a present prefix only', () => {
    expect(stripPrefix('refs/heads/main', 'refs/heads/')).toBe('main');
    expect(stripPrefix('refs/tags/v1', 'refs/heads/')).toBeUndefined();
  });

  it('adds https to a bare host only', () => {
    expect(withHttps('app.vercel.app')).toBe('https://app.vercel.app');
    expect(withHttps('https://x.test/a')).toBe('https://x.test/a');
  });

  it('treats null, undefined, empty and blank strings as absent', () => {
    expect(nonEmpty('x')).toBe('x');
    expect(nonEmpty('')).toBeUndefined();
    expect(nonEmpty(' '.repeat(3))).toBeUndefined();
    expect(nonEmpty(null)).toBeUndefined();
    expect(nonEmpty(undefined)).toBeUndefined();
  });
});

describe('ownValue', () => {
  const table: Record<string, number> = { a: 1 };

  it('returns an own value', () => {
    expect(ownValue(table, 'a')).toBe(1);
  });

  it.each(PROTOTYPE_KEYS)('never resolves the inherited member %s', key => {
    expect(ownValue(table, key)).toBeUndefined();
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

  it('sanitizes before measuring', () => {
    expect(truncate('a\u{0}b\u{D800}', 10)).toBe('ab�');
  });
});

describe('ignored and mapped', () => {
  it('sanitizes a reason and caps it at 200 characters', () => {
    const result = ignored(`github event "${'\u{0}\u{D800}x'.repeat(100)}" is not mapped`);
    if (result.kind !== 'ignored') {
      throw new Error('expected ignored');
    }
    expect(result.reason.length).toBeLessThanOrEqual(200);
    expectPostgresSafe(result.reason);
  });

  it('sanitizes every string fact and keeps booleans', () => {
    const message = buildMessage({ title: 'T', url: undefined, severity: Severities.info, fields: [], footer: 'F' });
    const result = mapped('github.push', { repo: 'a\u{0}/b\u{D800}', hasCommits: true }, message);
    if (result.kind !== 'event') {
      throw new Error('expected event');
    }
    expect(result.facts).toStrictEqual({ repo: 'a/b�', hasCommits: true });
  });
});

describe('buildMessage', () => {
  it('truncates every part to the NeutralMessage limits and drops empty optionals', () => {
    const message = buildMessage({
      title: 'x'.repeat(1000),
      url: undefined,
      description: 'y'.repeat(5000),
      severity: Severities.info,
      fields: Array.from({ length: 15 }, (_, index) => ({ name: `f${index}`, value: 'v'.repeat(200) })),
      footer: 'Footer',
      actor: { name: 'a'.repeat(1000) },
    });
    expect(message.title).toHaveLength(NeutralMessageLimits.title);
    expect(message.description).toHaveLength(NeutralMessageLimits.description);
    expect(message.fields).toHaveLength(NeutralMessageLimits.fields);
    expect(message.actor?.name).toHaveLength(NeutralMessageLimits.actorName);
    expect('url' in message).toBe(false);
    expect(neutralMessageSchema.parse(message)).toStrictEqual(message);
  });

  it('drops trailing fields until the whole message fits the total limit', () => {
    const message = buildMessage({
      title: 't'.repeat(1000),
      url: undefined,
      description: 'd'.repeat(5000),
      severity: Severities.info,
      fields: Array.from({ length: 10 }, (_, index) => ({ name: `f${index}`, value: 'v'.repeat(2000) })),
      footer: 'f'.repeat(5000),
      actor: { name: 'a'.repeat(1000) },
    });
    expect(neutralMessageLength(message)).toBeLessThanOrEqual(NeutralMessageLimits.total);
    expect(message.fields.length).toBeLessThan(10);
    expect(message.fields[0]?.name).toBe('f0');
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

  it('sanitizes every text, the url included', () => {
    const message = buildMessage({
      title: 'T\u{0}\u{D800}',
      url: 'https://x.test/a\u{0}b',
      description: 'd\u{0}',
      severity: Severities.info,
      fields: [{ name: 'N\u{0}', value: 'v\u{DC00}' }],
      footer: 'F\u{0}',
      actor: { name: 'a\u{0}' },
    });
    expectPostgresSafe(message);
    expect(message.url).toBe('https://x.test/ab');
    expect(neutralMessageSchema.parse(message)).toStrictEqual(message);
  });
});

describe('neutralMessageSchema', () => {
  const base = { title: 'T', severity: 'info', fields: [], footer: 'F' };

  it('caps the actor name', () => {
    expect(neutralMessageSchema.safeParse({ ...base, actor: { name: 'a'.repeat(256) } }).success).toBe(true);
    expect(neutralMessageSchema.safeParse({ ...base, actor: { name: 'a'.repeat(257) } }).success).toBe(false);
  });

  it('rejects a message over the 6000-character total even when every part is within its own limit', () => {
    const oversized = {
      ...base,
      title: 't'.repeat(256),
      description: 'd'.repeat(2000),
      fields: Array.from({ length: 4 }, () => ({ name: 'n', value: 'v'.repeat(1000) })),
      footer: 'f'.repeat(100),
    };
    expect(neutralMessageLength(oversized)).toBeGreaterThan(NeutralMessageLimits.total);
    expect(neutralMessageSchema.safeParse(oversized).success).toBe(false);
    expect(neutralMessageSchema.safeParse({ ...oversized, fields: oversized.fields.slice(0, 3) }).success).toBe(true);
  });
});
