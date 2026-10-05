/* eslint-disable sonarjs/hardcoded-secret-signatures -- fixture secrets, not real ones */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createMoccoServer, signIdentity, StatusClient, verifyWebhook } from './mocco-node';

const SECRET = 'fixture-webhook-secret';
const sign = (timestamp: number, body: string) => {
  const signed = `${timestamp}.${body}`;
  return `t=${timestamp},v1=${createHmac('sha256', SECRET).update(signed).digest('hex')}`;
};

describe('@mocco/node', () => {
  it("gives the server client the status namespace, over the client's key and base URL", async () => {
    const urls: string[] = [];
    const mocco = createMoccoServer({
      secretKey: 'mk_sec_0123456789abcdefghijklmnopqrstuv',
      baseUrl: 'https://mocco.test/v1',
      fetch: async input => {
        urls.push(String(input));
        return await Promise.resolve(Response.json({ monitors: [] }));
      },
    });

    expect(mocco.status).toBeInstanceOf(StatusClient);
    expect(await mocco.status.monitors.list()).toEqual([]);
    expect(urls).toEqual(['https://mocco.test/v1/monitors']);
  });

  it('signs identities as hex HMAC-SHA256 of the external id', () => {
    expect(signIdentity('secret', 'user-42')).toBe(createHmac('sha256', 'secret').update('user-42').digest('hex'));
  });

  it('verifies a fresh, untampered webhook, and refuses tampered, stale and malformed ones', () => {
    const now = new Date('2026-10-02T00:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    const body = '{"type":"ota.promotion.requested"}';

    expect(() => {
      verifyWebhook({ body, signatureHeader: sign(timestamp, body), secret: SECRET, now });
    }).not.toThrow();
    expect(() => {
      verifyWebhook({ body: `${body} `, signatureHeader: sign(timestamp, body), secret: SECRET, now });
    }).toThrow(/doesn't match/u);
    expect(() => {
      verifyWebhook({ body, signatureHeader: sign(timestamp - 600, body), secret: SECRET, now });
    }).toThrow(/too old/u);
    expect(() => {
      verifyWebhook({ body, signatureHeader: 'nonsense', secret: SECRET, now });
    }).toThrow(/malformed/u);
  });
});
