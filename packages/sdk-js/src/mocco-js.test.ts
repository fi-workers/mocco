import { describe, expect, it } from 'vitest';

import { createHelp, createMocco } from './mocco-js';

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

  it('reads the help center with the publishable key', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return await Promise.resolve(Response.json({ id: 'abc123', locale: 'en' }));
    }) as unknown as typeof fetch;

    const help = createHelp({ publishableKey: 'mk_pub_abc', baseUrl: 'https://mocco.test/v1', fetch: fetchImpl });

    expect(await help.getArticle('abc123', { locale: 'en' })).toMatchObject({ id: 'abc123' });
    expect(calls).toEqual(['https://mocco.test/v1/help/articles/abc123?locale=en']);
  });
});
