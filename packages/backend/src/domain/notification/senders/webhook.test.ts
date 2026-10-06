// The webhook sender against a local server: the Standard Webhooks signature, the status mapping,
// redirects refused, and the address policy applied to literal IPs and to what a name resolves to
// (the check sits in the socket's lookup, so the connection goes to the checked address).
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

import { isPublicAddress } from '@mocco/common/address-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  newWebhookSecret,
  signWebhook,
  WebhookResultKinds,
  WebhookSender,
} from '@backend/domain/notification/senders/webhook';

import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

const SENT_AT = new Date('2026-10-06T09:00:00.000Z');
const isAnyAddress = () => true;

const message = (url: string) => ({
  url,
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_1',
  sentAt: SENT_AT,
  body: '{"type":"incident.updated"}',
});

describe('WebhookSender', () => {
  let server: Server;
  let received: Received[];
  let reply: { status: number; headers?: Record<string, string> };
  let base: string;

  beforeEach(async () => {
    received = [];
    reply = { status: 204 };
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        received.push({ headers: request.headers, body });
        response.writeHead(reply.status, reply.headers);
        response.end();
      });
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${String(port)}`;
  });
  afterEach(async () => {
    await new Promise(resolve => {
      server.close(resolve);
    });
  });

  it('signs the body the Standard Webhooks way', async () => {
    const sender = new WebhookSender({ policy: isAnyAddress, isHttpAllowed: true });

    expect(await sender.send(message(`${base}/hook`))).toEqual({ kind: WebhookResultKinds.sent, status: 204 });
    const [hit] = received;
    expect(hit?.body).toBe('{"type":"incident.updated"}');
    expect(hit?.headers['content-type']).toBe('application/json');
    expect(hit?.headers['webhook-id']).toBe('msg_1');
    expect(hit?.headers['webhook-timestamp']).toBe('1791277200');
    // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Buffer is the base64 codec available here
    const key = Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64');
    const expected = createHmac('sha256', key).update('msg_1.1791277200.{"type":"incident.updated"}').digest('base64');
    expect(hit?.headers['webhook-signature']).toBe(`v1,${expected}`);
    expect(signWebhook(message('').secret, 'msg_1', 1_791_277_200, '{"type":"incident.updated"}')).toBe(
      `v1,${expected}`,
    );
    expect(newWebhookSecret()).toMatch(/^whsec_[\w+/]{32}$/u);
  });

  it('maps the answer: redirects and 4xx are permanent, 410 is gone, 429 and 5xx are transient', async () => {
    const sender = new WebhookSender({ policy: isAnyAddress, isHttpAllowed: true });
    const kindOf = async (status: number, headers?: Record<string, string>) => {
      reply = { status, ...(headers !== undefined && { headers }) };
      const result = await sender.send(message(`${base}/hook`));
      return result.kind;
    };

    expect(await kindOf(302, { location: 'http://169.254.169.254/' })).toBe(WebhookResultKinds.permanent);
    expect(await kindOf(400)).toBe(WebhookResultKinds.permanent);
    expect(await kindOf(410)).toBe(WebhookResultKinds.gone);
    expect(await kindOf(429)).toBe(WebhookResultKinds.transient);
    expect(await kindOf(503)).toBe(WebhookResultKinds.transient);
    // The redirect was answered, never followed.
    expect(received).toHaveLength(5);
  });

  it('refuses private addresses, literal or resolved, and anything but https', async () => {
    const guarded = new WebhookSender({ policy: isPublicAddress, isHttpAllowed: true });
    const literal = await guarded.send(message(`${base}/hook`));
    const { port } = new URL(base);
    const resolved = await guarded.send(message(`http://localhost:${port}/hook`));
    const metadata = await guarded.send(message('http://[fd00:ec2::254]/latest'));
    const plain = await new WebhookSender({ policy: isAnyAddress }).send(message(`${base}/hook`));

    expect(literal).toEqual({ kind: WebhookResultKinds.permanent, reason: '127.0.0.1 is not a public address' });
    expect(resolved).toMatchObject({ kind: WebhookResultKinds.permanent });
    expect(resolved.kind === WebhookResultKinds.sent ? '' : resolved.reason).toMatch(/not a public address/u);
    expect(metadata).toMatchObject({ kind: WebhookResultKinds.permanent });
    expect(plain).toEqual({ kind: WebhookResultKinds.permanent, reason: 'only https URLs are called' });
    expect(received).toEqual([]);
  });

  it('gives up on a receiver that does not answer in time', async () => {
    server.removeAllListeners('request');
    server.on('request', () => {
      // Never answers.
    });
    const result = await new WebhookSender({ policy: isAnyAddress, isHttpAllowed: true, timeoutMs: 100 }).send(
      message(`${base}/slow`),
    );
    expect(result).toMatchObject({ kind: WebhookResultKinds.transient });
    server.closeAllConnections();
  });
});
