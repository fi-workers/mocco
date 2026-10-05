import { MonitorKinds, httpMonitorSpecSchema, tcpMonitorSpecSchema } from '@mocco/common/status';
import { describe, expect, it } from 'vitest';

import { monitorTargetOf } from '@backend/domain/status/monitor-target';

const http = (url: string) => httpMonitorSpecSchema.parse({ kind: MonitorKinds.http, url });

describe('monitorTargetOf', () => {
  it('keeps only the host and a non-default port of an HTTP URL', () => {
    expect(monitorTargetOf(http('https://user:pass@api.acme.test:8443/v1/health?token=abc&api_key=k#frag'))).toBe(
      'api.acme.test:8443',
    );
    expect(monitorTargetOf(http('https://api.acme.test/health'))).toBe('api.acme.test');
    expect(monitorTargetOf(http('https://api.acme.test:443/'))).toBe('api.acme.test');
    expect(monitorTargetOf(http('https://token@[2001:db8::1]:9000/x'))).toBe('[2001:db8::1]:9000');
  });

  it('shows a TCP monitor as host and port', () => {
    expect(
      monitorTargetOf(tcpMonitorSpecSchema.parse({ kind: MonitorKinds.tcp, host: 'db.acme.internal', port: 5432 })),
    ).toBe('db.acme.internal:5432');
  });

  it('is null for a URL that does not parse', () => {
    expect(monitorTargetOf({ ...http('https://api.acme.test'), url: 'not a url' })).toBeNull();
  });
});
