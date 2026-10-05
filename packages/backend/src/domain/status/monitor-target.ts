// What a monitor checks, in a form safe to show outside the monitor editor. An HTTP monitor's
// URL can carry credentials (`https://user:pass@host`) or a token in its path or query
// (`?token=…`), so anything that leaves the console (alerts, domain events, agents) shows only
// the host and port.
import { MonitorKinds } from '@mocco/common/status';

import type { MonitorSpec } from '@mocco/common/status';

/** An HTTP URL's host (with its port when it isn't the scheme's default), never its
 * credentials, path, query or fragment; a TCP host and port. Null for a URL that doesn't parse. */
export function monitorTargetOf(spec: MonitorSpec): string | null {
  if (spec.kind === MonitorKinds.tcp) {
    return `${spec.host}:${spec.port}`;
  }
  return URL.canParse(spec.url) ? new URL(spec.url).host : null;
}
