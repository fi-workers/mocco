// /feedback/<board>/changelog.rss on a help site's host (#176): next.config.ts rewrites it here,
// and the backend answers with the board's published changelog as RSS, or 404.
import { changelogRssFor } from '@mocco/backend/seo/handler';

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const board = typeof req.query.board === 'string' ? req.query.board : '';
  const file = await changelogRssFor(req.headers.host ?? '', board);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  res.status(file.status).send(file.body);
}
