import { describe, expect, it } from 'vitest';

import { addressPolicyFor } from './address-policy';

describe('addressPolicyFor', () => {
  it('holds a hosted location to public addresses and lets a private location reach anything', () => {
    expect(addressPolicyFor(true)('10.0.0.1')).toBe(false);
    expect(addressPolicyFor(true)('8.8.8.8')).toBe(true);
    expect(addressPolicyFor(false)('10.0.0.1')).toBe(true);
    expect(addressPolicyFor(false)('169.254.169.254')).toBe(true);
  });
});
