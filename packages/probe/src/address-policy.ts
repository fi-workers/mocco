// Which addresses a hosted probe may connect to (ADR 0027 §7). A hosted probe runs on Mocco's
// network, so a monitor must not be able to point it at anything that isn't on the public
// internet: private, loopback, link-local (cloud metadata lives at 169.254.169.254 and
// fd00:ec2::254), shared CGNAT space, and the reserved, documentation and multicast ranges.
// A private location skips this list: reaching private targets is what it is for.
import { BlockList, isIP } from 'node:net';

/* eslint-disable sonarjs/no-hardcoded-ip -- these ranges are the policy itself */

const IPV4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT shared address space
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
];

const IPV6_BLOCKED: readonly (readonly [string, number])[] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo, which tunnels to any IPv4 address
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, which embeds any IPv4 address
  ['fc00::', 7], // unique local, including fd00::/8 and fd00:ec2::254
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

/* eslint-enable sonarjs/no-hardcoded-ip */

const blocked = [
  ...IPV4_BLOCKED.map(([network, prefix]) => [network, prefix, 'ipv4'] as const),
  ...IPV6_BLOCKED.map(([network, prefix]) => [network, prefix, 'ipv6'] as const),
].reduce((list, [network, prefix, type]) => {
  list.addSubnet(network, prefix, type);
  return list;
}, new BlockList());

/**
 * Whether a hosted probe may connect to `address`. Anything that isn't a well-formed IP is
 * refused. IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`) are checked against the IPv4 ranges.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Decides whether an address may be connected to. */
export type AddressPolicy = (address: string) => boolean;

/** A hosted location refuses everything but public addresses; a private location allows all. */
export const addressPolicyFor = (isHosted: boolean): AddressPolicy => (isHosted ? isPublicAddress : () => true);
