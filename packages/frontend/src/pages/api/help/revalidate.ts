// Rebuild help center pages now (#96): `POST /api/help/revalidate` with `{ paths }`, the
// pages' internal paths (`/_sites/<slug>/…`). The backend calls it after a publish,
// unpublish, delete or new translation, with the job tick's secret as a bearer token.
// Pages that fail to rebuild still refresh on their own within a minute (ADR 0015).
import { checkRevalidateRequest, helpRevalidateSecrets } from '@mocco/backend/helpcenter/instance';

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const checked = checkRevalidateRequest(req.headers.authorization, req.body, helpRevalidateSecrets());
  if (checked.status !== 200) {
    res.status(checked.status).json({ error: 'refused' });
    return;
  }
  const results = await Promise.allSettled(checked.paths.map(async path => await res.revalidate(path)));
  res.status(200).json({
    revalidated: results.filter(result => result.status === 'fulfilled').length,
    failed: results.filter(result => result.status === 'rejected').length,
  });
}
