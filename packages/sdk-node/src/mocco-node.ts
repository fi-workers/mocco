// The public entry of @mocco/node (the package's "exports" target).
import { createHmac, timingSafeEqual } from 'node:crypto';

import { MoccoClient } from '@mocco/sdk-core';
import { StatusClient } from '@mocco/sdk-core/status';

/** Heartbeat pings for cron jobs and workers: `await heartbeat('mhb_…').wrap(async () => job())`. */
export { Heartbeat, heartbeat, HeartbeatPingError } from '@mocco/sdk-core';
export type { HeartbeatOptions, HeartbeatPingKind } from '@mocco/sdk-core';

export interface MoccoNodeOptions {
  /** A secret key (`mk_sec_…`). Keep it on the server. */
  secretKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** The server client, with its product namespaces. */
export type MoccoServer = MoccoClient & {
  /** The project's status page as code: monitors (upserted by key), incidents, maintenance and
   * components. The key needs `status:read` to read and `status:write` to change. */
  status: StatusClient;
};

/** The server client. */
export function createMoccoServer(options: MoccoNodeOptions): MoccoServer {
  const client = new MoccoClient({
    key: options.secretKey,
    isBrowser: false,
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
  return Object.assign(client, { status: new StatusClient(client) });
}

/**
 * The identity hash an app sends with a signed-in user (platform foundations §5): hex
 * HMAC-SHA256 of the user's id with the project's identity secret. Compute it on your
 * server; never ship the secret to a client.
 */
export function signIdentity(identitySecret: string, externalId: string): string {
  return createHmac('sha256', identitySecret).update(externalId).digest('hex');
}

/** Why a webhook signature was refused. */
export class MoccoWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoccoWebhookError';
  }
}

/* eslint-disable sonarjs/null-dereference -- header and each part are strings, never null */
const parseSignature = (header: string) =>
  Object.fromEntries(
    header.split(',').map(part => {
      const [key = '', ...rest] = part.trim().split('=');
      return [key, rest.join('=')];
    }),
  );
/* eslint-enable sonarjs/null-dereference */

/**
 * Verify a webhook from Mocco. Mocco signs `<timestamp>.<raw body>` with the endpoint's
 * secret and sends `mocco-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`. Pass the raw
 * body (not re-serialized JSON). Throws MoccoWebhookError when the signature is wrong or
 * older than `toleranceSeconds` (default 5 minutes), so replays are refused.
 */
export function verifyWebhook(input: {
  body: string;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): void {
  const { t, v1 } = parseSignature(input.signatureHeader);
  const timestamp = Number(t);
  if (!Number.isSafeInteger(timestamp) || v1 === undefined || v1 === '') {
    throw new MoccoWebhookError('The mocco-signature header is malformed');
  }
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) {
    throw new MoccoWebhookError('The webhook is too old (or the clocks disagree)');
  }
  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest();
  const given = Buffer.from(v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new MoccoWebhookError("The webhook signature doesn't match");
  }
}

export { MoccoClient, MoccoError, MoccoNetworkError } from '@mocco/sdk-core';
export type { WhoAmI } from '@mocco/sdk-core';
export { StatusClient } from '@mocco/sdk-core/status';
export type {
  StatusAffectedComponent,
  StatusComponent,
  StatusComponentStatus,
  StatusImpact,
  StatusIncident,
  StatusIncidentCreateRequest,
  StatusIncidentDetail,
  StatusIncidentPolicy,
  StatusIncidentSeverity,
  StatusIncidentStatus,
  StatusIncidentUpdate,
  StatusIncidentUpdateRequest,
  StatusLocation,
  StatusMaintenance,
  StatusMaintenanceInput,
  StatusMonitor,
  StatusMonitorInput,
  StatusMonitorKind,
  StatusMonitorSpec,
  StatusMonitorState,
  StatusMonitorUpsertResult,
  StatusPage,
  StatusQuorumMode,
} from '@mocco/sdk-core/status';
