// "Was this helpful?" from the public help site (#216): `POST /api/help/feedback` with
// `{ site, article, helpful, locale?, comment?, visitorId? }`. The same service and rules as
// `POST /v1/help/articles/:id/feedback`, by the site's slug instead of a key: published
// articles only, one answer per visitor, article and day, limited per client address.
import { allowHelpFeedbackFrom, getHelpDomain } from '@mocco/backend/helpcenter/instance';
import { helpV1ArticleRefSchema, helpV1FeedbackInputSchema } from '@mocco/common/help-v1';
import { z } from 'zod';

import type { NextApiRequest, NextApiResponse } from 'next';

const bodySchema = helpV1FeedbackInputSchema.extend({
  site: z.string().regex(/^[a-z0-9-]{1,80}$/u),
  article: helpV1ArticleRefSchema,
});

/** The client's address: the first forwarded hop (hashed before anything keeps it). */
const addressOf = (req: NextApiRequest): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',', 1)[0]?.trim();
  return first ?? req.socket.remoteAddress ?? 'unknown';
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const body = bodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Send { site, article, helpful }' });
    return;
  }
  const address = addressOf(req);
  if (!(await allowHelpFeedbackFrom(address))) {
    res.status(429).json({ error: 'Too many answers' });
    return;
  }
  const { site, article, visitorId, ...answer } = body.data;
  try {
    const result = await getHelpDomain().helpFeedback.recordOnSite(
      site,
      article,
      answer,
      visitorId === undefined ? { network: { address, userAgent: req.headers['user-agent'] ?? '' } } : { visitorId },
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof Error && (error.name === 'HelpSiteNotFoundError' || error.name === 'HelpNodeNotFoundError')) {
      res.status(404).json({ error: 'No such published article' });
      return;
    }
    throw error;
  }
}
