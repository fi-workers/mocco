// Mocco on Mocco: `GET /api/self/end-user-token` answers the signed-in console user an end-user
// token for Mocco's own project, which the console's "What's new" badge and feedback sheet send
// to /v1 (docs/reference/mocco-on-mocco.md). 401 without a session, 404 when not configured.
// Never cached, and the token is never logged.
import { selfEndUserTokenFor } from '@mocco/backend/self/end-user-token';

import { headersFromNode } from '@frontend/lib/node-headers';

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'GET only' });
    return;
  }
  const answer = await selfEndUserTokenFor(headersFromNode(req.headers));
  res.status(answer.status).json(answer.body);
}
