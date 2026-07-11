// Mounts the backend's vendor-neutral auth handler (Node variant for the Pages
// Router). No auth-vendor import here — the fetch→Node bridge lives behind the
// backend's vendor boundary (AuthService.nodeHandler).
import { getServices } from '@mocco/backend/auth/instance';

import type { NextApiRequest, NextApiResponse } from 'next';

// better-auth reads the raw request body itself.
export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await getServices().auth.nodeHandler(req, res);
}
