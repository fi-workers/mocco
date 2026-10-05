// /indexnow.txt on a help center's host (#367): the key that proves the site owns its host
// to IndexNow. next.config.ts rewrites it here; the app's own host answers 404.
import { seoFileFor, SeoFiles } from '@mocco/backend/seo/handler';

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const file = await seoFileFor(SeoFiles.indexNowKey, req.headers.host ?? '', () => []);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Cache-Control', 'public, s-maxage=86400');
  res.status(file.status).send(file.body);
}
