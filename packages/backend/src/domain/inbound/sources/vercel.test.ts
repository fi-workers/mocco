import { NeutralMessageLimits } from '@mocco/common/notification';
import { describe, expect, it } from 'vitest';

import { deliveryId, parse, sourceEvent, verify } from '@backend/domain/inbound/sources/vercel';
import {
  encode,
  expectEvent,
  expectIgnored,
  hmacHex,
  patchFixture,
  readFixture,
} from '@backend/domain/inbound/testing/fixtures';

const secret = 'vercel-webhook-secret';
const noHeaders = new Headers();

const signed = (signature: string) => new Headers({ 'x-vercel-signature': signature });
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

describe('vercel verify', () => {
  const body = encode(readFixture('vercel/deployment-error.json'));

  it('accepts an HMAC-SHA1 hex signature of the raw body', () => {
    expect(verify(body, signed(hmacHex('sha1', secret, body)), secret)).toBe(true);
  });

  it('accepts an uppercase hex signature', () => {
    expect(verify(body, signed(hmacHex('sha1', secret, body).toUpperCase()), secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = encode(`${readFixture('vercel/deployment-error.json')}\n`);
    expect(verify(tampered, signed(hmacHex('sha1', secret, body)), secret)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verify(body, signed(hmacHex('sha1', 'wrong', body)), secret)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verify(body, noHeaders, secret)).toBe(false);
  });

  it('rejects a signature with an extra trailing character', () => {
    expect(verify(body, signed(`${hmacHex('sha1', secret, body)}0`), secret)).toBe(false);
  });

  it('rejects a prefixed or SHA-256 signature', () => {
    expect(verify(body, signed(`sha1=${hmacHex('sha1', secret, body)}`), secret)).toBe(false);
    expect(verify(body, signed(hmacHex('sha256', secret, body)), secret)).toBe(false);
  });
});

describe('vercel deliveryId', () => {
  it('reads the payload id', () => {
    expect(deliveryId(readFixture('vercel/deployment-created.json'), noHeaders)).toBe('whk_created_1');
  });

  it('is undefined for malformed JSON or a payload without an id', () => {
    expect(deliveryId('{nope', noHeaders)).toBeUndefined();
    expect(deliveryId('{"type":"deployment.created"}', noHeaders)).toBeUndefined();
    expect(deliveryId('{"id":""}', noHeaders)).toBeUndefined();
  });

  it('strips NUL and lone surrogates from the id', () => {
    expect(deliveryId(String.raw`{"id":"whk\u0000_1\ud800"}`, noHeaders)).toBe('whk_1�');
  });
});

describe('vercel parse', () => {
  const facts = { project: 'acme-web', target: 'production', branch: 'main' };
  const fields = [
    { name: 'Environment', value: 'production', inline: true },
    { name: 'Branch', value: '`main`', inline: true },
  ];
  const common = {
    url: 'https://acme-web-4f7g2k1ab-acme.vercel.app',
    description: '> fix(checkout): guard missing cart id  Longer body',
    fields,
    footer: 'Vercel · acme-web',
  };

  it('maps deployment.created', () => {
    const event = expectEvent(parse(readFixture('vercel/deployment-created.json'), noHeaders));
    expect(event.type).toBe('vercel.deployment.created');
    expect(event.facts).toStrictEqual(facts);
    expect(event.message).toStrictEqual({ title: 'Started · acme-web', severity: 'info', ...common });
  });

  it('maps a production deployment.succeeded', () => {
    const event = expectEvent(parse(readFixture('vercel/deployment-succeeded-production.json'), noHeaders));
    expect(event.type).toBe('vercel.deployment.succeeded');
    expect(event.facts).toStrictEqual(facts);
    expect(event.message).toStrictEqual({ title: 'Ready · acme-web', severity: 'success', ...common });
  });

  it('maps a preview deployment.succeeded too (filtering is left to rules)', () => {
    const event = expectEvent(parse(readFixture('vercel/deployment-succeeded-preview.json'), noHeaders));
    expect(event.type).toBe('vercel.deployment.succeeded');
    expect(event.facts).toStrictEqual({ project: 'acme-web', target: 'preview', branch: 'feat/new-cart' });
    expect(event.message.fields).toStrictEqual([
      { name: 'Environment', value: 'preview', inline: true },
      { name: 'Branch', value: '`feat/new-cart`', inline: true },
    ]);
  });

  it('maps deployment.error', () => {
    const event = expectEvent(parse(readFixture('vercel/deployment-error.json'), noHeaders));
    expect(event.type).toBe('vercel.deployment.error');
    expect(event.facts).toStrictEqual(facts);
    expect(event.message).toStrictEqual({ title: 'Failed · acme-web', severity: 'error', ...common });
  });

  it('maps deployment.canceled', () => {
    const event = expectEvent(parse(readFixture('vercel/deployment-canceled.json'), noHeaders));
    expect(event.type).toBe('vercel.deployment.canceled');
    expect(event.facts).toStrictEqual(facts);
    expect(event.message).toStrictEqual({ title: 'Canceled · acme-web', severity: 'info', ...common });
  });

  it('parses a minimal relay-style payload, omitting the unknown branch', () => {
    const body = JSON.stringify({
      id: 'whk_1',
      type: 'deployment.succeeded',
      payload: { name: 'app', target: 'production', deployment: { url: 'app.vercel.app' } },
    });
    const event = expectEvent(parse(body, noHeaders));
    expect(event.facts).toStrictEqual({ project: 'app', target: 'production' });
    expect(event.message).toStrictEqual({
      title: 'Ready · app',
      url: 'https://app.vercel.app',
      severity: 'success',
      fields: [{ name: 'Environment', value: 'production', inline: true }],
      footer: 'Vercel · app',
    });
  });

  it('falls back to the dashboard link and truncates a long commit message', () => {
    const body = patchFixture('vercel/deployment-error.json', {
      'payload.deployment.url': undefined,
      'payload.deployment.meta': { githubCommitMessage: 'm'.repeat(1000) },
    });
    const event = expectEvent(parse(body, noHeaders));
    expect(event.message.url).toBe('https://vercel.com/acme/acme-web/89qyp1cskzkLrVicDaZoDbjyHuDJ');
    expect(event.message.description).toBe(`> ${'m'.repeat(299)}…`);
  });

  it('truncates an oversized project name in the title', () => {
    const body = patchFixture('vercel/deployment-error.json', { 'payload.name': 'p'.repeat(400) });
    expect(expectEvent(parse(body, noHeaders)).message.title).toHaveLength(NeutralMessageLimits.title);
  });

  it('ignores other event types, naming them', () => {
    expect(expectIgnored(parse(readFixture('vercel/project-created.json'), noHeaders))).toBe(
      'vercel event "project.created" is not mapped',
    );
  });

  it('falls back on an empty target, project name and branch', () => {
    const body = patchFixture('vercel/deployment-error.json', {
      'payload.target': '',
      'payload.name': '',
      'payload.deployment.meta.githubCommitRef': '',
    });
    const event = expectEvent(parse(body, noHeaders));
    expect(event.facts).toStrictEqual({ project: 'acme-web', target: 'preview' });
    expect(event.message.title).toBe('Failed · acme-web');

    const nameless = patchFixture('vercel/deployment-error.json', {
      'payload.name': '',
      'payload.deployment.name': '',
    });
    expect(expectEvent(parse(nameless, noHeaders)).facts.project).toBe('prj_12HKQaOmR5t5Uy6vdcQsNIiZgHGB');
  });

  it.each(PROTOTYPE_KEYS)('never resolves the prototype member %s as an event type', key => {
    const body = patchFixture('vercel/deployment-error.json', { type: key });
    expect(expectIgnored(parse(body, noHeaders))).toBe(`vercel event "${key}" is not mapped`);
  });

  it('strips NUL and lone surrogates from JSON escapes', () => {
    const body = String.raw`{"id":"x","type":"deployment.error","payload":{"name":"app\u0000\ud800","target":"production","deployment":{"meta":{"githubCommitRef":"main\u0000"}}}}`;
    const event = expectEvent(parse(body, noHeaders));
    expect(event.facts).toStrictEqual({ project: 'app�', target: 'production', branch: 'main' });
    const unmapped = String.raw`{"id":"x","type":"deploy\u0000\udfff"}`;
    expect(expectIgnored(parse(unmapped, noHeaders))).toBe('vercel event "deploy�" is not mapped');
  });

  it('ignores malformed JSON and payloads without a type', () => {
    expect(expectIgnored(parse('{nope', noHeaders))).toBe('malformed JSON body');
    expect(expectIgnored(parse('{"id":"x"}', noHeaders))).toBe('vercel payload does not match the expected shape');
    expect(expectIgnored(parse('{"id":"x","type":"deployment.error","payload":"x"}', noHeaders))).toBe(
      'vercel deployment payload does not match the expected shape',
    );
  });
});

describe('vercel sourceEvent', () => {
  it('is the payload type', () => {
    expect(sourceEvent(readFixture('vercel/deployment-created.json'), noHeaders)).toBe('deployment.created');
    expect(sourceEvent(readFixture('vercel/project-created.json'), noHeaders)).toBe('project.created');
  });

  it('is undefined for a body without a type', () => {
    expect(sourceEvent('{}', noHeaders)).toBeUndefined();
    expect(sourceEvent('not json', noHeaders)).toBeUndefined();
  });
});
