import { Configure } from './lib/configure';
import { Monitoring } from './lib/monitoring';

// Client-side monitoring init (Next auto-loads this file). Empty DSN → no-op.
Monitoring.init(Configure.SentryDsn, Configure.Environment);
