import { Configure } from '../../../lib/configure';
import { Monitoring } from '../../../lib/monitoring';

import type { NextApiRequest, NextApiResponse } from 'next';

// Verification-only, gated on Configure.DebugEnabled (NEXT_PUBLIC_DEBUG=true):
// throws inside an API handler and reports it, so the "error caught inside a
// plain API route" path can be confirmed. 404 when debug is off.
export default function handler(_req: NextApiRequest, res: NextApiResponse): void {
  if (!Configure.DebugEnabled) {
    res.status(404).end();
    return;
  }
  const error = new Error('Monitoring API-route verification error');
  Monitoring.captureException(error);
  throw error;
}
