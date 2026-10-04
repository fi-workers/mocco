import { describe, expect, it } from 'vitest';

import { addressPolicyFor, isPublicAddress } from './address-policy';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '203.0.114.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', address => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['10.0.0.1', 'private'],
    ['172.16.5.4', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['169.254.169.254', 'cloud metadata'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.254', 'CGNAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['198.18.0.1', 'benchmarking'],
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['fd00:ec2::254', 'AWS metadata over IPv6'],
    ['fd12:3456::1', 'unique local'],
    ['fc00::1', 'unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata, in hex'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['2002:a00:1::', '6to4 of 10.0.0.1'],
    ['2001:0:4136:e378::1', 'Teredo'],
  ])('refuses %s (%s)', address => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('refuses anything that is not an IP address', () => {
    expect(isPublicAddress('localhost')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('addressPolicyFor', () => {
  it('holds a hosted location to public addresses and lets a private location reach anything', () => {
    expect(addressPolicyFor(true)('10.0.0.1')).toBe(false);
    expect(addressPolicyFor(true)('8.8.8.8')).toBe(true);
    expect(addressPolicyFor(false)('10.0.0.1')).toBe(true);
    expect(addressPolicyFor(false)('169.254.169.254')).toBe(true);
  });
});
