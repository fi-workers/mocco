import { describe, expect, it } from 'vitest';

import { readConfig } from './config';

const base = { MOCCO_URL: 'https://www.mocco.work', MOCCO_PROBE_TOKEN: 'mpl_abc' };

describe('readConfig', () => {
  it('needs only the URL and the token; a private location is the default', () => {
    expect(readConfig(base).config).toEqual({ ...base, MOCCO_PROBE_CONCURRENCY: 20, MOCCO_PROBE_HOSTED: false });
  });

  it('reads concurrency and the hosted flag', () => {
    const { config } = readConfig({ ...base, MOCCO_PROBE_CONCURRENCY: '5', MOCCO_PROBE_HOSTED: 'true' });

    expect(config).toMatchObject({ MOCCO_PROBE_CONCURRENCY: 5, MOCCO_PROBE_HOSTED: true });
  });

  it('lists what is wrong instead of starting', () => {
    const { config, problems } = readConfig({
      MOCCO_URL: 'ftp://mocco',
      MOCCO_PROBE_TOKEN: 'not-a-location-token',
      MOCCO_PROBE_CONCURRENCY: '0',
      MOCCO_PROBE_HOSTED: 'yes',
    });

    expect(config).toBeUndefined();
    // eslint-disable-next-line sonarjs/null-dereference -- each problem is a string, never null
    expect(problems?.map(problem => problem.slice(0, problem.indexOf(':')))).toEqual([
      'MOCCO_URL',
      'MOCCO_PROBE_TOKEN',
      'MOCCO_PROBE_CONCURRENCY',
      'MOCCO_PROBE_HOSTED',
    ]);
  });
});
