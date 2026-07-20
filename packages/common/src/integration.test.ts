import { describe, expect, it } from 'vitest';

import {
  commitConfigSchema,
  commitDetailQueryInputSchema,
  commitDetailSchema,
  commitSchema,
  commitsPageSchema,
  commitsQueryInputSchema,
} from './integration';

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

describe('commitsQueryInputSchema', () => {
  it('defaults cursor to null and limit to 20 when omitted', () => {
    const parsed = commitsQueryInputSchema.parse({
      workspaceId: '33333333-3333-4333-8333-333333333333',
      repoId: '22222222-2222-4222-8222-222222222222',
    });

    expect(parsed.cursor).toBeNull();
    expect(parsed.limit).toBe(20);
  });

  it('rejects a limit of 0 or 51, and accepts 1 and 50', () => {
    const base = {
      workspaceId: '33333333-3333-4333-8333-333333333333',
      repoId: '22222222-2222-4222-8222-222222222222',
    };

    expect(() => commitsQueryInputSchema.parse({ ...base, limit: 0 })).toThrow();
    expect(() => commitsQueryInputSchema.parse({ ...base, limit: 51 })).toThrow();
    expect(commitsQueryInputSchema.parse({ ...base, limit: 1 }).limit).toBe(1);
    expect(commitsQueryInputSchema.parse({ ...base, limit: 50 }).limit).toBe(50);
  });

  it('rejects a non-numeric cursor and accepts a digit-string cursor or null', () => {
    const base = {
      workspaceId: '33333333-3333-4333-8333-333333333333',
      repoId: '22222222-2222-4222-8222-222222222222',
    };

    // A schema-valid-but-non-numeric cursor must be rejected here, at the
    // boundary — not surface as `BigInt('abc')` throwing a SyntaxError deep
    // inside CommitSyncService.listCommits.
    expect(() => commitsQueryInputSchema.parse({ ...base, cursor: 'abc' })).toThrow();

    expect(commitsQueryInputSchema.parse({ ...base, cursor: '42' }).cursor).toBe('42');
    expect(commitsQueryInputSchema.parse({ ...base, cursor: null }).cursor).toBeNull();
  });
});

describe('commitConfigSchema', () => {
  const validConfig = {
    version: 1 as const,
    pipeline: 'deploy',
    steps: [{ run: 'build', executor: 'github-actions' }],
  };

  it('round-trips a present, valid config with no issues', () => {
    const input = { present: true, valid: true, config: validConfig, issues: [] };

    expect(commitConfigSchema.parse(input)).toEqual(input);
  });

  it('round-trips a present, invalid config with a null parsed config and issues', () => {
    const input = {
      present: true,
      valid: false,
      config: null,
      issues: [{ path: 'steps.0.run', message: 'required', code: 'invalid_type', line: 3 }],
    };

    expect(commitConfigSchema.parse(input)).toEqual(input);
  });

  it('round-trips an absent config (no .mocco.yml at this commit)', () => {
    const input = { present: false, valid: false, config: null, issues: [] };

    expect(commitConfigSchema.parse(input)).toEqual(input);
  });
});

describe('commitDetailSchema', () => {
  const commit = {
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    seq: '9007199254740993',
    sha: 'abc123def456',
    branch: 'main',
    message: 'fix: correct off-by-one',
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    committedAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  it('round-trips a commit with a present config', () => {
    const input = {
      commit,
      config: {
        present: true,
        valid: true,
        config: { version: 1 as const, pipeline: 'deploy', steps: [{ run: 'build', executor: 'github-actions' }] },
        issues: [],
      },
    };

    expect(commitDetailSchema.parse(input)).toEqual(input);
  });

  it('round-trips a commit with config: null (not yet snapshotted)', () => {
    const input = { commit, config: null };

    expect(commitDetailSchema.parse(input)).toEqual(input);
  });
});

describe('commitDetailQueryInputSchema', () => {
  it('accepts a workspaceId and commitId pair', () => {
    const input = {
      workspaceId: '33333333-3333-4333-8333-333333333333',
      commitId: '11111111-1111-4111-8111-111111111111',
    };

    expect(commitDetailQueryInputSchema.parse(input)).toEqual(input);
  });
});
