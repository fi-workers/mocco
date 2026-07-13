import { describe, expect, it } from 'vitest';

import { toRepo } from './provider';

describe('toRepo', () => {
  it('maps a GitHub repo to a neutral AvailableRepoDto', () => {
    const raw = { id: 987_654, name: 'api', default_branch: 'main', owner: { login: 'fi-workers' } };
    expect(toRepo(raw)).toEqual({
      externalRepoId: '987654',
      owner: 'fi-workers',
      name: 'api',
      defaultBranch: 'main',
    });
  });

  it('stringifies the numeric id (external ids are strings across providers)', () => {
    expect(toRepo({ id: 1, name: 'n', default_branch: 'trunk', owner: { login: 'o' } }).externalRepoId).toBe('1');
  });
});
