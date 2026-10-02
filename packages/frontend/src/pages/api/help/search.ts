// Public help center search (#96): `GET /api/help/search?site=<slug>&locale=<lang>&q=<query>`
// for the public site's search page. Read-only and published content only; the query
// is capped, so a request stays cheap.
import { getHelpDomain } from '@mocco/backend/helpcenter/instance';

import type { NextApiRequest, NextApiResponse } from 'next';

const MAX_QUERY = 100;

const param = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'GET only' });
    return;
  }
  const site = param(req.query.site);
  if (!/^[a-z0-9-]+$/u.test(site)) {
    res.status(400).json({ error: 'site is required' });
    return;
  }
  const locale = param(req.query.locale);
  const query = param(req.query.q).slice(0, MAX_QUERY);
  try {
    const result = await getHelpDomain().helpPublic.search(site, locale, query);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error && error.name === 'HelpSiteNotFoundError') {
      res.status(404).json({ error: 'No such help center' });
      return;
    }
    throw error;
  }
}
