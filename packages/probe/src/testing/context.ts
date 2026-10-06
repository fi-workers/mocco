// Check contexts for tests: a lookup answered from a table (no DNS), and the two policies.
import { isIP } from 'node:net';

import { isPublicAddress, type AddressPolicy } from '@mocco/common/address-policy';

import type { CheckContext } from '../check-report';
import type { Lookup, ResolvedAddress } from '../resolve';

export const TEST_NOW = new Date('2026-10-05T00:00:00.000Z');

/** Resolves names from `table`; anything else is ENOTFOUND, as the system resolver would say. */
export const tableLookup =
  (table: Record<string, string[]>): Lookup =>
  async hostname => {
    await Promise.resolve();
    const addresses = table[hostname];
    if (addresses === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    return addresses.map((address): ResolvedAddress => ({ address, family: isIP(address) }));
  };

export const allowAll: AddressPolicy = () => true;

/**
 * The hosted policy, with one exception: the fixture server's own address. The tests need
 * something to connect to, and everything else is held to the real block list.
 */
export const hostedExcept =
  (...allowed: string[]): AddressPolicy =>
  address =>
    allowed.includes(address) || isPublicAddress(address);

export const testContext = (
  policy: AddressPolicy = allowAll,
  lookup: Lookup = tableLookup({ localhost: ['127.0.0.1'] }),
): CheckContext => ({
  resolver: { lookup, policy },
  userAgent: 'mocco-probe/test',
  now: () => TEST_NOW,
});
