// The signed state a deciding tool carries across its confirmation round trip.
//
// A deciding tool answers its first call with `input_required`: it asks the person to
// confirm, and hands the client a `requestState` to echo back with the answer. That state
// comes back as attacker-controlled input, and it is what says which decision was shown
// to the person — so it is signed, bound, and short-lived:
//
// - **Signed** with a key derived from AUTH_SECRET, so a client cannot change the
//   decision it echoes after the person has seen a different one.
// - **Bound** to the person, the client and the method, so state minted for one person
//   (or one connected app) is refused when another presents it.
// - **Short-lived**: five minutes is long enough to read a confirmation and answer it,
//   and short enough that an unanswered one is not a standing permission.
//
// The SDK runs `verify` before the tool does and answers any failure itself, with a fixed
// `-32602` that says nothing about why. Signed, not encrypted: the payload is readable by
// the client, so it carries only what the confirmation already showed.
import { createHash } from 'node:crypto';

import { createRequestStateCodec } from '@modelcontextprotocol/server';

import { userIdOf } from '@backend/transport/mcp/tools/runs';

import type { RequestStateCodec } from '@modelcontextprotocol/server';

export type Confirmations = RequestStateCodec;

/** How long a confirmation stays answerable. */
const TTL_SECONDS = 5 * 60;

/** The codec for every deciding tool. Each tool parses the payload it gets back, and
 * names itself in it, so one tool's state cannot be replayed into another. */
export function createConfirmations(secret: string): Confirmations {
  return createRequestStateCodec({
    // Domain-separated from every other key derived from the same secret.
    key: createHash('sha256').update(`mocco-mcp-request-state:${secret}`).digest('hex'),
    ttlSeconds: TTL_SECONDS,
    bind: ctx => [userIdOf(ctx), ctx.http?.authInfo?.clientId ?? '', ctx.mcpReq.method].join('\0'),
  });
}
