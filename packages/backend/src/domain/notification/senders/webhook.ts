// The notifications foundation's outbound webhook sender (platform foundations §12): a signed
// POST of a JSON body to a URL someone outside the workspace chose, made from Mocco's network.
//
// Signing follows Standard Webhooks: `webhook-id`, `webhook-timestamp` (unix seconds) and
// `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, keyed by the secret after
// its `whsec_` prefix. The receiver checks the signature and rejects old timestamps.
//
// SSRF: only https (plain http only where the deployment's policy says so), every address the
// host resolves to must pass the address policy (`isPublicAddress` from @mocco/common in
// production), and the check runs in the connection's own `lookup`, so the socket connects to
// the address that was checked and a DNS answer can't change in between. A literal IP is checked
// before connecting. Redirects are never followed: a 3xx is a permanent failure.
import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { BlockedAddressError } from '@backend/domain/notification/errors';

import type { AddressPolicy } from '@mocco/common/address-policy';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { IncomingMessage } from 'node:http';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** A new signing secret, shown once to whoever registered the webhook. */
export function newWebhookSecret(): string {
  // Buffer is the base64 codec available without V8's --js-base-64 flag (see secret-box.ts).
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('base64')}`;
}

/** The `webhook-signature` value for a message. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- secret is a string
  const encoded = secret.startsWith(WEBHOOK_SECRET_PREFIX) ? secret.slice(WEBHOOK_SECRET_PREFIX.length) : secret;
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- see newWebhookSecret
  const key = Buffer.from(encoded, 'base64');
  const mac = createHmac('sha256', key)
    .update(`${id}.${String(timestamp)}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

export interface WebhookMessage {
  url: string;
  secret: string;
  /** Stable across retries of one message, so the receiver can drop a duplicate. */
  id: string;
  sentAt: Date;
  body: string;
}

export const WebhookResultKinds = {
  sent: 'sent',
  /** Worth trying again: a timeout, a network error, 408, 429 or 5xx. */
  transient: 'transient',
  /** Trying again won't help: a refused address, a redirect, another 4xx. */
  permanent: 'permanent',
  /** 410 Gone: the receiver says to stop sending. */
  gone: 'gone',
} as const;

export type WebhookResult =
  | { kind: typeof WebhookResultKinds.sent; status: number }
  | {
      kind: typeof WebhookResultKinds.transient | typeof WebhookResultKinds.permanent | typeof WebhookResultKinds.gone;
      reason: string;
      status?: number;
    };

export interface WebhookSenderOptions {
  /** Which addresses may be connected to: `isPublicAddress` everywhere but in tests. */
  policy: AddressPolicy;
  /** Whether `http:` URLs may be called (only a test's local server). Default false. */
  isHttpAllowed?: boolean;
  timeoutMs?: number;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** The bare host of a URL (`[::1]` → `::1`). */
const bareHost = (host: string) =>
  // eslint-disable-next-line sonarjs/null-dereference -- host is a string
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

/** What an answer's status means for the delivery. */
// eslint-disable-next-line sonarjs/function-return-type -- one union type, built per status range
function classify(status: number): WebhookResult {
  if (status >= 200 && status < 300) {
    return { kind: WebhookResultKinds.sent, status };
  }
  if (status >= 300 && status < 400) {
    return { kind: WebhookResultKinds.permanent, reason: `HTTP ${String(status)}: redirects are not followed`, status };
  }
  if (status === 410) {
    return { kind: WebhookResultKinds.gone, reason: 'HTTP 410: the receiver asked to stop', status };
  }
  const isTransient = status === 408 || status === 429 || status >= 500;
  return {
    kind: isTransient ? WebhookResultKinds.transient : WebhookResultKinds.permanent,
    reason: `HTTP ${String(status)}`,
    status,
  };
}

export class WebhookSender {
  constructor(private readonly options: WebhookSenderOptions) {}

  /** A `lookup` for the socket that refuses a name with any address the policy refuses. */
  private guardedLookup() {
    const { policy } = this.options;
    return (hostname: string, lookupOptions: LookupOptions, callback: LookupCallback) => {
      const answer = (addresses: LookupAddress[]) => {
        const refused = addresses.find(candidate => !policy(candidate.address));
        const [first] = addresses;
        if (refused !== undefined || first === undefined) {
          callback(new BlockedAddressError(hostname, refused?.address ?? 'nothing'), []);
          return;
        }
        if (lookupOptions.all === true) {
          callback(null, addresses);
          return;
        }
        callback(null, first.address, first.family);
      };
      // eslint-disable-next-line unicorn/prefer-await -- the socket hands us a callback, not a promise
      dnsLookup(hostname, { all: true, verbatim: true }).then(answer, (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), []);
      });
    };
  }

  /** Why `url` is never called (not a URL, not https, a literal address the policy refuses), or
   * undefined. A host name is checked when it is resolved, on every send. */
  refusalOf(url: string): string | undefined {
    const { policy, isHttpAllowed = false } = this.options;
    if (!URL.canParse(url)) {
      return 'not a URL';
    }
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:' && !(isHttpAllowed && protocol === 'http:')) {
      return 'only https URLs are called';
    }
    const host = bareHost(hostname);
    return isIP(host) !== 0 && !policy(host) ? `${host} is not a public address` : undefined;
  }

  async send(message: WebhookMessage): Promise<WebhookResult> {
    const { timeoutMs = 10_000 } = this.options;
    const refusal = this.refusalOf(message.url);
    if (refusal !== undefined) {
      return { kind: WebhookResultKinds.permanent, reason: refusal };
    }
    const url = new URL(message.url);
    const isHttps = url.protocol === 'https:';
    const timestamp = Math.floor(message.sentAt.getTime() / 1000);
    const request = isHttps ? httpsRequest : httpRequest;
    return await new Promise<WebhookResult>(resolve => {
      const outgoing = request(
        url,
        {
          method: 'POST',
          lookup: this.guardedLookup(),
          timeout: timeoutMs,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Mocco-Webhooks/1',
            'webhook-id': message.id,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': signWebhook(message.secret, message.id, timestamp, message.body),
          },
        },
        (response: IncomingMessage) => {
          // The body is never read: only the status matters.
          response.resume();
          resolve(classify(response.statusCode ?? 0));
        },
      );
      outgoing.on('timeout', () => {
        outgoing.destroy(new Error(`no answer within ${String(timeoutMs)} ms`));
      });
      outgoing.on('error', (error: Error) => {
        const isBlocked = error instanceof BlockedAddressError;
        resolve({
          kind: isBlocked ? WebhookResultKinds.permanent : WebhookResultKinds.transient,
          reason: error.message.slice(0, 500),
        });
      });
      outgoing.end(message.body);
    });
  }
}
