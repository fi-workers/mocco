import { describe, expect, it } from 'vitest';

import { commitSchema, commitsPageSchema } from './integration';

describe('commitSchema', () => {
  it('round-trips a neutral commit', () => {
    const input = {
      id: '11111111-1111-4111-8111-111111111111',
      repoId: '22222222-2222-4222-8222-222222222222',
      seq: '9007199254740993', // beyond MAX_SAFE_INTEGER — stays a string end-to-end
      sha: 'abc123def456',
      branch: 'main',
      message: 'fix: correct off-by-one',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      committedAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    const parsed = commitSchema.parse(input);

    expect(parsed).toEqual(input);
    expect(typeof parsed.seq).toBe('string');
  });
});

describe('commitsPageSchema', () => {
  it('accepts a page of commits with a nullable cursor', () => {
    const commit = {
      id: '11111111-1111-4111-8111-111111111111',
      repoId: '22222222-2222-4222-8222-222222222222',
      seq: '42',
      sha: 'abc123def456',
      branch: 'main',
      message: 'fix: correct off-by-one',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      committedAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    expect(commitsPageSchema.parse({ commits: [commit], nextCursor: '41' })).toEqual({
      commits: [commit],
      nextCursor: '41',
    });
    expect(commitsPageSchema.parse({ commits: [], nextCursor: null })).toEqual({
      commits: [],
      nextCursor: null,
    });
  });
});
