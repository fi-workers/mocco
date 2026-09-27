// The pure source adapters by kind. InboundService picks one from the source row;
// nothing here does I/O.
import { InboundKinds } from '@mocco/common/inbound';

import {
  deliveryId as githubDeliveryId,
  parse as githubParse,
  sourceEvent as githubSourceEvent,
  verify as githubVerify,
} from '@backend/domain/inbound/sources/github';
import {
  deliveryId as sentryDeliveryId,
  parse as sentryParse,
  sourceEvent as sentrySourceEvent,
  verify as sentryVerify,
} from '@backend/domain/inbound/sources/sentry';
import {
  deliveryId as vercelDeliveryId,
  parse as vercelParse,
  sourceEvent as vercelSourceEvent,
  verify as vercelVerify,
} from '@backend/domain/inbound/sources/vercel';

import type { ParsedInbound } from '@backend/domain/inbound/sources/shared';
import type { InboundKind } from '@mocco/common/inbound';

/** One vendor's webhook contract. Signatures are checked on the raw bytes; the rest
 * reads the decoded text. None of them throws. */
export interface SourceAdapter {
  verify(rawBody: Uint8Array, headers: Headers, secret: string): boolean;
  deliveryId(rawBody: string, headers: Headers): string | undefined;
  sourceEvent(rawBody: string, headers: Headers): string | undefined;
  parse(rawBody: string, headers: Headers): ParsedInbound;
}

export const sourceAdapters: Readonly<Record<InboundKind, SourceAdapter>> = {
  [InboundKinds.sentry]: {
    verify: sentryVerify,
    deliveryId: sentryDeliveryId,
    sourceEvent: sentrySourceEvent,
    parse: sentryParse,
  },
  [InboundKinds.vercel]: {
    verify: vercelVerify,
    deliveryId: vercelDeliveryId,
    sourceEvent: vercelSourceEvent,
    parse: vercelParse,
  },
  [InboundKinds.github]: {
    verify: githubVerify,
    deliveryId: githubDeliveryId,
    sourceEvent: githubSourceEvent,
    parse: githubParse,
  },
};
