// Inbound-domain errors. SourceService throws them; the inbound router maps each base
// to its tRPC code. Messages never carry a secret, sealed value or ingest key.
import { BadRequestError, NotFoundError } from '@backend/domain/errors';

import type { InboundKind } from '@mocco/common/inbound';

/** A source the caller referenced doesn't exist or isn't in their workspace. */
export class InboundSourceNotFoundError extends NotFoundError {
  constructor(sourceId: string, options?: ErrorOptions) {
    super(`Inbound source ${sourceId} was not found`, options);
    this.name = 'InboundSourceNotFoundError';
  }
}

/** Sentry and Vercel sources need the signing secret the vendor shows. */
export class InboundSecretRequiredError extends BadRequestError {
  constructor(kind: InboundKind) {
    super(`A ${kind} source needs the signing secret ${kind} shows for the webhook`);
    this.name = 'InboundSecretRequiredError';
  }
}

/** GitHub sources use a secret Mocco generates; a pasted one is refused. */
export class InboundSecretNotAcceptedError extends BadRequestError {
  constructor(kind: InboundKind) {
    super(`A ${kind} source uses a secret Mocco generates; do not pass one`);
    this.name = 'InboundSecretNotAcceptedError';
  }
}
