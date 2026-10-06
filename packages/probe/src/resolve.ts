// Name resolution with the address policy applied. Every connection a check makes, including
// each redirect hop, goes through `resolveTarget` and then connects to the exact address it
// returned, so a name that resolves to a public address when checked and a private one a
// moment later (DNS rebinding) can't slip past: there is no second lookup to rebind.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

import { BlockedAddressError, NoAddressError } from './errors';

import type { AddressPolicy } from '@mocco/common/address-policy';

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Every address a name resolves to. */
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemLookup: Lookup = async hostname => await dnsLookup(hostname, { all: true, verbatim: true });

export interface Resolver {
  lookup: Lookup;
  policy: AddressPolicy;
}

export interface ResolvedTarget {
  /** The address to connect to: the one that was checked. */
  address: string;
  family: 4 | 6;
  /** Time spent resolving; 0 for an IP literal. */
  dnsMs: number;
}

/** The host without the brackets of an IPv6 literal (`[::1]` in a URL). */
export const bareHost = (host: string): string =>
  // eslint-disable-next-line sonarjs/null-dereference -- host is a string, never null
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

/**
 * Resolves `host` and checks every address it resolves to against the policy. All of them must
 * pass, so a name can't mix one public record with a private one and hope the private one is
 * picked at connect time.
 */
export async function resolveTarget(host: string, resolver: Resolver): Promise<ResolvedTarget> {
  const hostname = bareHost(host);
  const literal = isIP(hostname);
  const started = performance.now();
  const addresses = literal === 0 ? await resolver.lookup(hostname) : [{ address: hostname, family: literal }];
  const dnsMs = literal === 0 ? performance.now() - started : 0;
  const refused = addresses.find(candidate => !resolver.policy(candidate.address));
  if (refused !== undefined) {
    throw new BlockedAddressError(hostname, refused.address);
  }
  const [first] = addresses;
  if (first === undefined) {
    throw new NoAddressError(hostname);
  }
  return { address: first.address, family: first.family === 6 ? 6 : 4, dnsMs };
}
