// Production composition root for the inbound domain. Lazy so builds don't need env at
// import. Inbound sources store sealed secrets, so the domain is available only when
// SECRETS_ENCRYPTION_KEYS is set: `getInbound()` returns undefined otherwise, and the
// ingest route (503) and the inbound router (PRECONDITION_FAILED) self-gate on it.
import { getEventBus } from '@backend/domain/events/instance';
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { InboundService } from '@backend/domain/inbound/InboundService';
import { InboundReceiptRepo } from '@backend/domain/inbound/repos/inbound-receipt.repo';
import { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import { SourceService } from '@backend/domain/inbound/SourceService';
import { getEnv } from '@backend/infra/config/env';
import { getSecretBox } from '@backend/infra/crypto/instance';
import { getDb } from '@backend/infra/db/client';

import type { EventPublisher } from '@backend/domain/events/ports';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
import type { Db } from '@backend/infra/db/types';

export interface InboundDomain {
  sources: SourceService;
  inbound: InboundService;
}

export interface InboundDomainDeps {
  box: Pick<SecretBox, 'seal' | 'open'>;
  bus: EventPublisher;
  now: () => Date;
  /** The app's own origin, for ingest URLs. */
  baseOrigin: string;
}

/** Build the inbound services over a db. The production root below binds it once;
 * tests call it with a pglite db and a SecretBox over a random key. */
export function createInboundDomain(db: Db, deps: InboundDomainDeps): InboundDomain {
  const sources = new InboundSourceRepo(db);
  return {
    sources: new SourceService({ sources, box: deps.box, baseOrigin: deps.baseOrigin }),
    inbound: new InboundService({
      sources,
      receipts: new InboundReceiptRepo(db),
      box: deps.box,
      bus: deps.bus,
      now: deps.now,
    }),
  };
}

const state: { inbound?: InboundDomain } = {};

/** The inbound services, or undefined when SECRETS_ENCRYPTION_KEYS is not set. */
export function getInbound(): InboundDomain | undefined {
  const env = getEnv();
  if (env.SECRETS_ENCRYPTION_KEYS !== undefined) {
    state.inbound ??= createInboundDomain(getDb(), {
      box: getSecretBox(),
      bus: getEventBus(),
      now: () => new Date(),
      baseOrigin: resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL }),
    });
  }
  return state.inbound;
}
