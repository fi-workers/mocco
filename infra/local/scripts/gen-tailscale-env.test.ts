import { describe, expect, it } from 'vitest';

import { dnsNameFromStatus, upsertEnvLine } from './gen-tailscale-env';

describe('dnsNameFromStatus', () => {
  it('strips a single trailing dot from Self.DNSName', () => {
    expect(dnsNameFromStatus({ Self: { DNSName: 'mac-mini.tailfd5d.ts.net.' } })).toBe('mac-mini.tailfd5d.ts.net');
  });

  it('returns the name as-is when there is no trailing dot', () => {
    expect(dnsNameFromStatus({ Self: { DNSName: 'mac-mini.tailfd5d.ts.net' } })).toBe('mac-mini.tailfd5d.ts.net');
  });

  it('throws when the top-level value has no Self', () => {
    expect(() => dnsNameFromStatus({})).toThrow(/Self\.DNSName/);
  });

  it('throws when Self has no DNSName', () => {
    expect(() => dnsNameFromStatus({ Self: {} })).toThrow(/Self\.DNSName/);
  });

  it('throws when DNSName is an empty string', () => {
    expect(() => dnsNameFromStatus({ Self: { DNSName: '' } })).toThrow(/Self\.DNSName/);
  });

  it('throws when DNSName is not a string', () => {
    expect(() => dnsNameFromStatus({ Self: { DNSName: 42 } })).toThrow(/Self\.DNSName/);
  });

  it('throws with an actionable message mentioning tailscale status', () => {
    expect(() => dnsNameFromStatus(null)).toThrow(/tailscale status/);
  });
});

describe('upsertEnvLine', () => {
  it('appends key=value when the key is absent from an empty file', () => {
    expect(upsertEnvLine('', 'SERVICE_DOMAIN', 'my-mac.ts.net')).toBe('SERVICE_DOMAIN=my-mac.ts.net\n');
  });

  it('appends key=value when the key is absent from a non-empty file', () => {
    const content = 'FOO=bar\nBAZ=qux\n';
    expect(upsertEnvLine(content, 'SERVICE_DOMAIN', 'my-mac.ts.net')).toBe(
      'FOO=bar\nBAZ=qux\nSERVICE_DOMAIN=my-mac.ts.net\n',
    );
  });

  it('replaces an existing key in place, preserving surrounding lines, comments, and order', () => {
    const content = '# comment\nFOO=bar\nSERVICE_DOMAIN=old.ts.net\nBAZ=qux\n';
    expect(upsertEnvLine(content, 'SERVICE_DOMAIN', 'new.ts.net')).toBe(
      '# comment\nFOO=bar\nSERVICE_DOMAIN=new.ts.net\nBAZ=qux\n',
    );
  });

  it('does not duplicate the key after replacing', () => {
    const content = 'SERVICE_DOMAIN=old.ts.net\n';
    const result = upsertEnvLine(content, 'SERVICE_DOMAIN', 'new.ts.net');
    expect(result.match(/^SERVICE_DOMAIN=/gm)).toHaveLength(1);
  });

  it('ends with exactly one trailing newline when the input already ends with one', () => {
    const content = 'FOO=bar\n';
    const result = upsertEnvLine(content, 'FOO', 'baz');
    expect(result).toBe('FOO=baz\n');
    expect(result.endsWith('\n\n')).toBe(false);
  });

  it('ends with exactly one trailing newline when the input has no trailing newline', () => {
    const content = 'FOO=bar';
    const result = upsertEnvLine(content, 'FOO', 'baz');
    expect(result).toBe('FOO=baz\n');
  });

  it('matches a key line even with leading whitespace, replacing it with an unindented key=value', () => {
    const content = '  SERVICE_DOMAIN=old.ts.net\n';
    expect(upsertEnvLine(content, 'SERVICE_DOMAIN', 'new.ts.net')).toBe('SERVICE_DOMAIN=new.ts.net\n');
  });
});
