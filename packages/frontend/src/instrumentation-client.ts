import { Configure } from '@frontend/lib/configure';
import { Monitoring } from '@frontend/lib/monitoring';

// Client-side monitoring init (Next auto-loads this file). Empty DSN → no-op.
Monitoring.init(Configure.SentryDsn, Configure.Environment);
