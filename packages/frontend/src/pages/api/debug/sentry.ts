import { Monitoring } from '../../../lib/monitoring';

import type { NextApiRequest, NextApiResponse } from 'next';

// Verification-only: throws inside an API handler and reports it, so the "error
// caught inside a plain API route" path can be confirmed. The client gets a 500.
// Safe to remove once monitoring is verified.
export default function handler(_req: NextApiRequest, _res: NextApiResponse): void {
  const error = new Error('Monitoring API-route verification error');
  Monitoring.captureException(error);
  throw error;
}
