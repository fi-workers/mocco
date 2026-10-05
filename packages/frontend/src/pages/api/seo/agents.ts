// llms.txt, llms-full.txt and the Markdown of each page, for coding agents and AI assistants
// (#366). next.config.ts rewrites `/llms.txt`, `/<locale>/llms.txt`, `/docs/<set>/<page>.md`,
// `/<locale>/articles/<ref>.md` — and the same pages asked for with `Accept: text/markdown` —
// here; the backend answers for the app or the help center the host belongs to.
import { agentFileFor, AgentFiles } from '@mocco/backend/seo/handler';
import { z } from 'zod';

import { guidesForAgents } from '@frontend/lib/customer-docs';

import type { NextApiRequest, NextApiResponse } from 'next';

const querySchema = z.object({
  file: z.enum([AgentFiles.llms, AgentFiles.llmsFull, AgentFiles.guide, AgentFiles.article]),
  locale: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u)
    .optional(),
  path: z.string().max(200).optional(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const query = querySchema.safeParse(req.query);
  if (!query.success) {
    res.status(404).send('Not found\n');
    return;
  }
  const file = await agentFileFor(req.headers.host ?? '', query.data, guidesForAgents);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('Vary', 'Accept');
  res.status(file.status).send(file.body);
}
