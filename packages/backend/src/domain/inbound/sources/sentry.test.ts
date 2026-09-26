import { NeutralMessageLimits } from '@mocco/common/notification';
import { describe, expect, it } from 'vitest';

import { deliveryId, parse, verify } from '@backend/domain/inbound/sources/sentry';
import {
  encode,
  expectEvent,
  expectIgnored,
  hmacHex,
  patchFixture,
  readFixture,
} from '@backend/domain/inbound/testing/fixtures';

const secret = 'sentry-client-secret';
const issueHeaders = new Headers({ 'sentry-hook-resource': 'issue' });
const created = 'sentry/issue-created.json';

const signed = (signature: string) => new Headers({ 'Sentry-Hook-Signature': signature });
const withLevel = (level: string) => patchFixture(created, { 'data.issue.level': level });
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

describe('sentry verify', () => {
  const body = encode(readFixture(created));

  it('accepts an HMAC-SHA256 hex signature of the raw body', () => {
    expect(verify(body, signed(hmacHex('sha256', secret, body)), secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verify(encode(`${readFixture(created)} `), signed(hmacHex('sha256', secret, body)), secret)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verify(body, signed(hmacHex('sha256', 'wrong', body)), secret)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verify(body, new Headers(), secret)).toBe(false);
  });

  it('rejects a signature with an extra trailing character', () => {
    expect(verify(body, signed(`${hmacHex('sha256', secret, body)}a`), secret)).toBe(false);
  });

  it('rejects a prefixed or SHA-1 signature', () => {
    expect(verify(body, signed(`sha256=${hmacHex('sha256', secret, body)}`), secret)).toBe(false);
    expect(verify(body, signed(hmacHex('sha1', secret, body)), secret)).toBe(false);
  });
});

describe('sentry deliveryId', () => {
  it('reads the Request-ID header', () => {
    const headers = new Headers({ 'Request-ID': 'b1f0a7c4-0f6e-4a55-9d5f-1a2b3c4d5e6f' });
    expect(deliveryId('{}', headers)).toBe('b1f0a7c4-0f6e-4a55-9d5f-1a2b3c4d5e6f');
  });

  it('is undefined without the header or when it is blank', () => {
    expect(deliveryId('{}', new Headers())).toBeUndefined();
    expect(deliveryId('{}', new Headers({ 'Request-ID': '  ' }))).toBeUndefined();
  });
});

describe('sentry parse', () => {
  it('maps issue.created to sentry.issue.created', () => {
    const event = expectEvent(parse(readFixture(created), issueHeaders));
    expect(event.type).toBe('sentry.issue.created');
    expect(event.facts).toStrictEqual({ project: 'web', environment: 'unknown', level: 'error' });
    expect(event.message).toStrictEqual({
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      url: 'https://example-org.sentry.io/issues/1234567890/',
      severity: 'error',
      fields: [
        { name: 'Issue', value: 'WEB-1Y', inline: true },
        { name: 'Level', value: 'error', inline: true },
        { name: 'Environment', value: 'unknown', inline: true },
        { name: 'Culprit', value: '`app/components/Checkout.tsx in handleSubmit`' },
      ],
      footer: 'Sentry · web',
    });
  });

  it('maps severity from the level and takes the environment when present', () => {
    const body = patchFixture(created, { 'data.issue.level': 'warning', 'data.issue.environment': 'production' });
    const event = expectEvent(parse(body, issueHeaders));
    expect(event.facts).toStrictEqual({ project: 'web', environment: 'production', level: 'warning' });
    expect(event.message.severity).toBe('warning');
  });

  it('treats fatal as error and info or debug as info', () => {
    expect(expectEvent(parse(withLevel('fatal'), issueHeaders)).message.severity).toBe('error');
    expect(expectEvent(parse(withLevel('info'), issueHeaders)).message.severity).toBe('info');
    expect(expectEvent(parse(withLevel('debug'), issueHeaders)).message.severity).toBe('info');
  });

  it('parses a minimal issue without project, level or links', () => {
    const body = JSON.stringify({ action: 'created', data: { issue: { title: 'NewError' } } });
    const event = expectEvent(parse(body, issueHeaders));
    expect(event.facts).toStrictEqual({ environment: 'unknown', level: 'error' });
    expect(event.message).toStrictEqual({
      title: 'NewError',
      severity: 'error',
      fields: [
        { name: 'Level', value: 'error', inline: true },
        { name: 'Environment', value: 'unknown', inline: true },
      ],
      footer: 'Sentry',
    });
  });

  it('truncates an oversized title to the limit', () => {
    const event = expectEvent(parse(patchFixture(created, { 'data.issue.title': 'E'.repeat(1000) }), issueHeaders));
    expect(event.message.title).toHaveLength(NeutralMessageLimits.title);
    expect(event.message.title.endsWith('…')).toBe(true);
  });

  it('ignores every other issue action, naming it', () => {
    expect(expectIgnored(parse(readFixture('sentry/issue-resolved.json'), issueHeaders))).toBe(
      'sentry action "resolved" is not mapped',
    );
    expect(expectIgnored(parse(patchFixture(created, { action: 'assigned' }), issueHeaders))).toBe(
      'sentry action "assigned" is not mapped',
    );
  });

  it('ignores resources other than issue', () => {
    const headers = new Headers({ 'sentry-hook-resource': 'event_alert' });
    expect(expectIgnored(parse(readFixture(created), headers))).toBe('sentry resource "event_alert" is not mapped');
    expect(expectIgnored(parse(readFixture(created), new Headers()))).toBe('missing Sentry-Hook-Resource header');
  });

  it('falls back on empty environment, level and project', () => {
    const body = patchFixture(created, {
      'data.issue.environment': '',
      'data.issue.level': '',
      'data.issue.project': { slug: '', name: '' },
    });
    const event = expectEvent(parse(body, issueHeaders));
    expect(event.facts).toStrictEqual({ environment: 'unknown', level: 'error' });
    expect(event.message.footer).toBe('Sentry');
  });

  it.each(PROTOTYPE_KEYS)('never resolves the prototype member %s as an action, level or resource', key => {
    expect(expectIgnored(parse(patchFixture(created, { action: key }), issueHeaders))).toBe(
      `sentry action "${key}" is not mapped`,
    );
    const event = expectEvent(parse(withLevel(key), issueHeaders));
    expect(event.message.severity).toBe('error');
    // The level fact is the lowercased level, whatever its value.
    expect(event.facts.level).toMatch(new RegExp(`^${key}$`, 'iu'));
    expect(event.facts.level).toMatch(/^[^A-Z]+$/u);
    const headers = new Headers({ 'sentry-hook-resource': key });
    expect(expectIgnored(parse(readFixture(created), headers))).toBe(`sentry resource "${key}" is not mapped`);
  });

  it('strips NUL and lone surrogates from JSON escapes', () => {
    const body = String.raw`{"action":"created","data":{"issue":{"title":"Boom\u0000\ud800","level":"error\u0000","project":{"slug":"web\udc00"}}}}`;
    const event = expectEvent(parse(body, issueHeaders));
    expect(event.message.title).toBe('Boom�');
    expect(event.facts).toStrictEqual({ project: 'web�', environment: 'unknown', level: 'error' });
    const action = String.raw`{"action":"x\u0000\ud800","data":{}}`;
    expect(expectIgnored(parse(action, issueHeaders))).toBe('sentry action "x�" is not mapped');
  });

  it('ignores malformed JSON and payloads without an issue', () => {
    expect(expectIgnored(parse('{nope', issueHeaders))).toBe('malformed JSON body');
    expect(expectIgnored(parse('{"action":"created","data":{}}', issueHeaders))).toBe(
      'sentry issue payload does not match the expected shape',
    );
    expect(expectIgnored(parse('[]', issueHeaders))).toBe('sentry issue payload does not match the expected shape');
  });
});
