import { describe, expect, it } from 'vitest';

import { resolveBaseOrigin, schemeFor } from '@backend/domain/execution/endpoints';

describe('schemeFor', () => {
  it('uses http for loopback hosts and https for everything else', () => {
    expect(
      ['localhost:3100', 'api.mocco.localhost:3217', '127.0.0.1:8080', '[::1]:3000'].map(host => schemeFor(host)),
    ).toEqual(['http', 'http', 'http', 'http']);
    expect(['www.mocco.club', 'api.mocco.club', 'localhost.example.com'].map(host => schemeFor(host))).toEqual([
      'https',
      'https',
      'https',
    ]);
  });

  it('builds the base origin from SERVICE_DOMAIN first', () => {
    expect(resolveBaseOrigin({ serviceDomain: 'www.mocco.club', vercelUrl: 'x.vercel.app' })).toBe(
      'https://www.mocco.club',
    );
  });
});
