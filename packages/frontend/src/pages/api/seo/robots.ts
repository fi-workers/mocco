// /robots.txt for every host this deployment serves (#363): next.config.ts rewrites it here,
// and the backend answers for the app or for the help center the host belongs to.
import { seoFileFor, SeoFiles } from '@mocco/backend/seo/handler';

import { listGuidePages } from '@frontend/lib/customer-docs';

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const file = await seoFileFor(SeoFiles.robots, req.headers.host ?? '', () => [
    { path: '/', lastModified: null },
    { path: '/docs', lastModified: null },
    ...listGuidePages(),
  ]);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(file.status).send(file.body);
}
