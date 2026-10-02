import { describe, expect, it } from 'vitest';

import { createMocco } from './mocco-js';

describe('@mocco/js', () => {
  it('uses a publishable key and refuses a secret one', async () => {
    const fetchImpl = (async () =>
      await Promise.resolve(
        Response.json({ projectId: 'p', kind: 'publishable', scopes: [] }),
      )) as unknown as typeof fetch;

    const mocco = createMocco({ publishableKey: 'mk_pub_abc', fetch: fetchImpl });

    expect(await mocco.whoami()).toMatchObject({ kind: 'publishable' });
    expect(mocco.client.keyKind).toBe('publishable');
  });
});
