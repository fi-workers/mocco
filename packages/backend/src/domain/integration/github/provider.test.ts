import { createHmac } from 'node:crypto';

import { FeedbackLinkKinds, FeedbackLinkStates } from '@mocco/common/feedback';
import { describe, expect, it } from 'vitest';

import { GithubApiError } from '@backend/domain/integration/github/errors';
import {
  CHECK_OUTPUT_MAX_CHARS,
  decodeGetContent,
  fitCheckOutput,
  toCheckRunBody,
  toClosingPullRequests,
  toListedCommit,
  toRepo,
  toSearchQuery,
  toSourceCommit,
  toTrackerIssue,
  toTrackerPull,
  toTrackerSearchItems,
  verify,
} from '@backend/domain/integration/github/provider';

describe('verify', () => {
  // Not a real credential — a fixture value hashed in-test with node:crypto to
  // compute a known-good HMAC (sonarjs flags any `secret`-named literal used
  // to key an HMAC as a hardcoded credential).
  const secret = 'a-test-webhook-secret';
  const rawBody = JSON.stringify({ hello: 'world' });
  // eslint-disable-next-line sonarjs/hardcoded-secret-signatures
  const validSignature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  it('returns true for a body signed with the matching secret', () => {
    expect(verify(rawBody, validSignature, secret)).toBe(true);
  });

  it('returns false when the body was tampered with after signing', () => {
    const tamperedBody = JSON.stringify({ hello: 'mallory' });
    expect(verify(tamperedBody, validSignature, secret)).toBe(false);
  });

  it('returns false when the signature was tampered with', () => {
    // sonarjs/null-dereference is a false positive: validSignature is always a
    // string (built from a template literal above), never null/undefined.
    // eslint-disable-next-line sonarjs/null-dereference
    const tamperedSignature = `${validSignature.slice(0, -1)}${validSignature.endsWith('0') ? '1' : '0'}`;
    expect(verify(rawBody, tamperedSignature, secret)).toBe(false);
  });

  it('returns false (does not throw) for a malformed signature', () => {
    expect(() => verify(rawBody, 'not-a-valid-signature', secret)).not.toThrow();
    expect(verify(rawBody, 'not-a-valid-signature', secret)).toBe(false);
  });

  it('returns false when no signature header was sent', () => {
    expect(verify(rawBody, null, secret)).toBe(false);
  });
});

describe('toSourceCommit', () => {
  it('maps a push-webhook commit to a neutral SourceCommit', () => {
    const raw = {
      id: '1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d',
      message: 'fix: correct off-by-one error',
      timestamp: '2026-07-18T10:00:00Z',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
    };
    expect(toSourceCommit(raw)).toEqual({
      sha: '1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d',
      message: 'fix: correct off-by-one error',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      committedAt: new Date('2026-07-18T10:00:00Z'),
    });
  });
});

describe('toListedCommit', () => {
  it('maps a REST list-commits item (nested commit.author) to a neutral SourceCommit', () => {
    const raw = {
      sha: '9f8e7d6c5b4a3928170695847362514a3b2c1d0',
      commit: {
        message: 'chore: bump deps',
        author: { name: 'Grace Hopper', email: 'grace@example.com', date: '2026-07-17T09:30:00Z' },
      },
    };
    expect(toListedCommit(raw)).toEqual({
      sha: '9f8e7d6c5b4a3928170695847362514a3b2c1d0',
      message: 'chore: bump deps',
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      committedAt: new Date('2026-07-17T09:30:00Z'),
    });
  });

  it('falls back to empty strings/epoch when GitHub reports a null git author', () => {
    const raw = { sha: 'deadbeef', commit: { message: 'msg', author: null } };
    expect(toListedCommit(raw)).toEqual({
      sha: 'deadbeef',
      message: 'msg',
      authorName: '',
      authorEmail: '',
      committedAt: new Date(0),
    });
  });
});

describe('decodeGetContent', () => {
  it('decodes a base64 file payload to the expected UTF-8 text', () => {
    const text = 'gate: production\ntimeout: 30\n';
    const raw = {
      type: 'file',
      encoding: 'base64',
      // Buffer is the available base64 encoder on this runtime (see provider.ts#decodeGetContent).
      // eslint-disable-next-line unicorn/prefer-uint8array-base64
      content: Buffer.from(text, 'utf8').toString('base64'),
      size: text.length,
      name: '.mocco.yml',
      path: '.mocco.yml',
      sha: 'abc123',
    };
    expect(decodeGetContent(raw)).toBe(text);
  });

  it('decodes correctly even when GitHub line-wraps the base64 content with newlines', () => {
    const text = 'a'.repeat(200);
    // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- see above.
    const wrapped = Buffer.from(text, 'utf8').toString('base64').replaceAll(/.{60}/g, '$&\n');
    expect(decodeGetContent({ type: 'file', encoding: 'base64', content: wrapped })).toBe(text);
  });

  it('rejects a directory listing (array response) with a mapped GithubApiError, not a crash', () => {
    const raw = [{ type: 'file', name: 'a.txt', path: 'a.txt', sha: 'x' }];
    expect(() => decodeGetContent(raw)).toThrow(GithubApiError);
  });

  it('rejects a response with no content field (e.g. a symlink) with a mapped GithubApiError', () => {
    const raw = { type: 'symlink', target: 'other/path', size: 4, name: '.mocco.yml', path: '.mocco.yml', sha: 'x' };
    expect(() => decodeGetContent(raw)).toThrow(GithubApiError);
  });

  it('rejects a non-string content with a mapped GithubApiError instead of a bad Buffer', () => {
    expect(() => decodeGetContent({ type: 'file', encoding: 'base64', content: 42 })).toThrow(GithubApiError);
  });
});

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

describe('toCheckRunBody', () => {
  it('maps a report to a completed check run with its Markdown output', () => {
    const report = {
      name: 'Mocco flags plan',
      headSha: 'abc',
      conclusion: 'neutral' as const,
      title: 'T',
      summary: 'S',
      text: 'X',
    };
    expect(toCheckRunBody(report)).toEqual({
      name: 'Mocco flags plan',
      head_sha: 'abc',
      status: 'completed',
      conclusion: 'neutral',
      output: { title: 'T', summary: 'S', text: 'X' },
    });
  });
});

describe('fitCheckOutput', () => {
  it('keeps Markdown within the limit as it is', () => {
    expect(fitCheckOutput('a'.repeat(CHECK_OUTPUT_MAX_CHARS))).toHaveLength(CHECK_OUTPUT_MAX_CHARS);
  });

  it('cuts longer Markdown to the limit and says so', () => {
    const fitted = fitCheckOutput('a'.repeat(CHECK_OUTPUT_MAX_CHARS + 10));
    expect(fitted).toHaveLength(CHECK_OUTPUT_MAX_CHARS);
    expect(fitted.endsWith('_…cut short: GitHub limits how long a check report can be._')).toBe(true);
  });
});

/** A closing pull request node of the GraphQL answer. */
const closingNode = (number: number, state: string, owner = 'acme') => ({
  id: `PR_${String(number)}`,
  number,
  title: 'Fix',
  url: `https://github.com/${owner}/app/pull/${String(number)}`,
  state,
  mergedAt: state === 'MERGED' ? '2026-10-02T00:00:00Z' : null,
  mergeCommit: state === 'MERGED' ? { oid: 'beef' } : null,
  repository: { name: 'app', owner: { login: owner } },
});

describe('issue tracker mappers', () => {
  const repo = { externalAccountId: '1', owner: 'Acme', name: 'App' };
  const base = { node_id: 'N', title: 'Dark mode', html_url: 'https://github.com/acme/app/issues/12' };

  it('maps an issue, and refuses a pull request asked for as an issue', () => {
    expect(toTrackerIssue({ ...base, number: 12, state: 'closed' })).toEqual({
      kind: FeedbackLinkKinds.issue,
      number: 12,
      nodeId: 'N',
      title: 'Dark mode',
      url: 'https://github.com/acme/app/issues/12',
      state: FeedbackLinkStates.closed,
      mergeCommitSha: null,
      mergedAt: null,
    });
    expect(toTrackerIssue({ ...base, number: 13, state: 'open', pull_request: { url: 'x' } })).toBeNull();
  });

  it('maps a pull request: merged with its merge commit, else open or closed without one', () => {
    const merged = toTrackerPull({
      ...base,
      number: 42,
      state: 'closed',
      merged: true,
      merge_commit_sha: 'c0ffee',
      merged_at: '2026-10-17T09:30:00Z',
    });
    expect(merged).toMatchObject({
      kind: FeedbackLinkKinds.pullRequest,
      state: FeedbackLinkStates.merged,
      mergeCommitSha: 'c0ffee',
      mergedAt: new Date('2026-10-17T09:30:00Z'),
    });
    // GitHub sets merge_commit_sha on an open pull request (its test merge): not a merge.
    expect(
      toTrackerPull({ ...base, number: 43, state: 'open', merged: false, merge_commit_sha: 'test' }),
    ).toMatchObject({
      state: FeedbackLinkStates.open,
      mergeCommitSha: null,
    });
    expect(toTrackerPull({ ...base, number: 44, state: 'closed', merged: false })).toMatchObject({
      state: FeedbackLinkStates.closed,
    });
  });

  it('keeps search results to the repo and the kind', () => {
    const items = [
      { ...base, number: 1, state: 'open', repository_url: 'https://api.github.com/repos/acme/app' },
      {
        ...base,
        number: 2,
        state: 'closed',
        repository_url: 'https://api.github.com/repos/acme/app',
        pull_request: { merged_at: '2026-10-01T00:00:00Z' },
      },
      {
        ...base,
        number: 3,
        state: 'closed',
        repository_url: 'https://api.github.com/repos/acme/app',
        pull_request: { merged_at: null },
      },
      { ...base, number: 4, state: 'open', repository_url: 'https://api.github.com/repos/acme/secret' },
      { not: 'an item' },
    ];
    expect(toTrackerSearchItems({ items }, repo, FeedbackLinkKinds.issue).map(item => item.number)).toEqual([1]);
    expect(
      toTrackerSearchItems({ items }, repo, FeedbackLinkKinds.pullRequest).map(item => [item.number, item.state]),
    ).toEqual([
      [2, FeedbackLinkStates.merged],
      [3, FeedbackLinkStates.closed],
    ]);
  });

  it('builds a search query that cannot leave the repo', () => {
    expect(toSearchQuery(repo, FeedbackLinkKinds.pullRequest, ' dark  repo:other/x "mode" ')).toBe(
      'repo:Acme/App is:pr dark mode',
    );
    expect(toSearchQuery(repo, FeedbackLinkKinds.issue, '')).toBe('repo:Acme/App is:issue');
  });

  it("keeps the closing pull requests in the issue's own repo", () => {
    const data = {
      repository: {
        issue: {
          closedByPullRequestsReferences: {
            nodes: [
              closingNode(1, 'MERGED'),
              closingNode(2, 'OPEN'),
              closingNode(3, 'CLOSED'),
              closingNode(4, 'MERGED', 'fork'),
            ],
          },
        },
      },
    };
    expect(toClosingPullRequests(data, repo).map(pull => [pull.number, pull.state, pull.mergeCommitSha])).toEqual([
      [1, FeedbackLinkStates.merged, 'beef'],
      [2, FeedbackLinkStates.open, null],
      [3, FeedbackLinkStates.closed, null],
    ]);
    expect(toClosingPullRequests({ repository: null }, repo)).toEqual([]);
  });
});
