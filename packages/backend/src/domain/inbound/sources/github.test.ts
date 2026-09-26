import { NeutralMessageLimits } from '@mocco/common/notification';
import { describe, expect, it } from 'vitest';

import { deliveryId, parse, sourceEvent, verify } from '@backend/domain/inbound/sources/github';
import { decodeBody } from '@backend/domain/inbound/sources/shared';
import {
  encode,
  expectEvent,
  expectIgnored,
  hmacHex,
  patchFixture,
  readFixture,
} from '@backend/domain/inbound/testing/fixtures';

const secret = 'github-webhook-secret';
const on = (event: string) => new Headers({ 'X-GitHub-Event': event });
const signed = (signature: string) => new Headers({ 'X-Hub-Signature-256': signature });
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

const actor = {
  name: 'octocat',
  url: 'https://github.com/octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
};

const prMessage = (label: string) => ({
  title: `PR ${label}: Guard missing cart id · acme/web`,
  url: 'https://github.com/acme/web/pull/42',
  fields: [
    { name: 'PR', value: '#42', inline: true },
    { name: 'Branch', value: '`fix/cart` → `main`', inline: true },
  ],
  actor,
  footer: 'GitHub · acme/web',
});

describe('github verify', () => {
  const text = readFixture('github/push.json');
  const body = encode(text);

  it('accepts sha256= plus an HMAC-SHA256 hex signature of the raw body', () => {
    expect(verify(body, signed(`sha256=${hmacHex('sha256', secret, body)}`), secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verify(encode(`${text}\n`), signed(`sha256=${hmacHex('sha256', secret, body)}`), secret)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verify(body, signed(`sha256=${hmacHex('sha256', 'wrong', body)}`), secret)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verify(body, new Headers(), secret)).toBe(false);
  });

  it('rejects a signature with an extra trailing character', () => {
    expect(verify(body, signed(`sha256=${hmacHex('sha256', secret, body)}a`), secret)).toBe(false);
  });

  it('verifies a BOM-prefixed body over its exact bytes, and still parses it', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(verify(withBom, signed(`sha256=${hmacHex('sha256', secret, withBom)}`), secret)).toBe(true);
    expect(verify(withBom, signed(`sha256=${hmacHex('sha256', secret, body)}`), secret)).toBe(false);
    const decoded = decodeBody(withBom);
    expect(decoded).toBe(text);
    expect(expectEvent(parse(decoded ?? '', on('push'))).type).toBe('github.push');
  });

  it('verifies a signed body that is not valid UTF-8, which then does not decode', () => {
    const invalid = new Uint8Array([...body.slice(0, 10), 0xff, ...body.slice(10)]);
    expect(verify(invalid, signed(`sha256=${hmacHex('sha256', secret, invalid)}`), secret)).toBe(true);
    expect(decodeBody(invalid)).toBeUndefined();
  });

  it('requires the sha256= prefix', () => {
    expect(verify(body, signed(hmacHex('sha256', secret, body)), secret)).toBe(false);
    expect(verify(body, signed(`sha1=${hmacHex('sha256', secret, body)}`), secret)).toBe(false);
    expect(verify(body, signed(`sha1=${hmacHex('sha1', secret, body)}`), secret)).toBe(false);
  });
});

describe('github deliveryId', () => {
  it('reads the X-GitHub-Delivery header', () => {
    const headers = new Headers({ 'X-GitHub-Delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958' });
    expect(deliveryId('{}', headers)).toBe('72d3162e-cc78-11e3-81ab-4c9367dc0958');
  });

  it('is undefined without the header', () => {
    expect(deliveryId('{}', new Headers())).toBeUndefined();
  });
});

describe('github parse: push', () => {
  it('maps a push with commits', () => {
    const event = expectEvent(parse(readFixture('github/push.json'), on('push')));
    expect(event.type).toBe('github.push');
    expect(event.facts).toStrictEqual({ repo: 'acme/web', refType: 'branch', branch: 'main', hasCommits: true });
    expect(event.message).toStrictEqual({
      title: '2 commits · acme/web:main',
      url: 'https://github.com/acme/web/compare/6113728f27ae...b2c3d4e5f6a7',
      description:
        '`a1b2c3d` fix(checkout): guard missing cart id\n`b2c3d4e` test(checkout): cover the expired session',
      severity: 'info',
      fields: [],
      actor,
      footer: 'GitHub · acme/web',
    });
  });

  it('still maps a push without commits, with hasCommits false', () => {
    const event = expectEvent(parse(readFixture('github/push-branch-deleted.json'), on('push')));
    expect(event.type).toBe('github.push');
    expect(event.facts).toStrictEqual({ repo: 'acme/web', refType: 'branch', branch: 'feat/old', hasCommits: false });
    expect(event.message.title).toBe('No new commits · acme/web:feat/old');
    expect(event.message.description).toBeUndefined();
  });

  it('maps a tag push without a branch fact', () => {
    const body = patchFixture('github/push.json', { ref: 'refs/tags/v1.4.0', commits: [] });
    const event = expectEvent(parse(body, on('push')));
    expect(event.type).toBe('github.push');
    expect(event.facts).toStrictEqual({ repo: 'acme/web', refType: 'tag', hasCommits: false });
    expect(event.message.title).toBe('No new commits · acme/web:v1.4.0');
  });

  it('lists at most five commits and says how many more there are', () => {
    const commits = Array.from({ length: 7 }, (_, index) => ({
      id: String(index).repeat(40),
      message: `commit ${index}`,
    }));
    const event = expectEvent(parse(patchFixture('github/push.json', { commits }), on('push')));
    expect(event.message.title).toBe('7 commits · acme/web:main');
    expect(event.message.description?.split('\n')).toHaveLength(6);
    expect(event.message.description?.endsWith('…and 2 more')).toBe(true);
  });

  it('parses the relay-style minimal push', () => {
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      compare: 'https://github.com/fi/relay/compare/a...b',
      repository: { full_name: 'fi/relay' },
      sender: { login: 'jh' },
      commits: [{ id: 'abcdef1234', message: 'feat: x\n\nbody' }],
    });
    const event = expectEvent(parse(body, on('push')));
    expect(event.message.title).toBe('1 commit · fi/relay:main');
    expect(event.message.description).toBe('`abcdef1` feat: x');
    expect(event.message.actor).toStrictEqual({ name: 'jh' });
  });
});

describe('github parse: pull_request', () => {
  it.each([
    ['pull-request-opened.json', 'github.pull_request.opened', 'opened', 'info'],
    ['pull-request-reopened.json', 'github.pull_request.reopened', 'reopened', 'info'],
    ['pull-request-closed-merged.json', 'github.pull_request.merged', 'merged', 'success'],
    ['pull-request-closed.json', 'github.pull_request.closed', 'closed', 'warning'],
  ])('maps %s to %s', (fixture, type, label, severity) => {
    const event = expectEvent(parse(readFixture(`github/${fixture}`), on('pull_request')));
    expect(event.type).toBe(type);
    expect(event.facts).toStrictEqual({ repo: 'acme/web', baseBranch: 'main' });
    expect(event.message).toStrictEqual({ ...prMessage(label), severity });
  });

  it('ignores other actions, naming them', () => {
    expect(expectIgnored(parse(readFixture('github/pull-request-edited.json'), on('pull_request')))).toBe(
      'github pull_request action "edited" is not mapped',
    );
  });

  it('truncates an oversized PR title', () => {
    const body = patchFixture('github/pull-request-opened.json', { 'pull_request.title': 'T'.repeat(500) });
    expect(expectEvent(parse(body, on('pull_request'))).message.title).toHaveLength(NeutralMessageLimits.title);
  });
});

describe('github parse: issues', () => {
  it.each([
    ['issues-opened.json', 'github.issues.opened', 'opened', 'warning'],
    ['issues-reopened.json', 'github.issues.reopened', 'reopened', 'warning'],
    ['issues-closed.json', 'github.issues.closed', 'closed', 'info'],
  ])('maps %s to %s', (fixture, type, action, severity) => {
    const event = expectEvent(parse(readFixture(`github/${fixture}`), on('issues')));
    expect(event.type).toBe(type);
    expect(event.facts).toStrictEqual({ repo: 'acme/web' });
    expect(event.message).toStrictEqual({
      title: `Issue ${action}: Checkout crashes after session expiry · acme/web`,
      url: 'https://github.com/acme/web/issues/7',
      severity,
      fields: [{ name: 'Issue', value: '#7', inline: true }],
      actor,
      footer: 'GitHub · acme/web',
    });
  });

  it('ignores other actions, naming them', () => {
    expect(expectIgnored(parse(readFixture('github/issues-labeled.json'), on('issues')))).toBe(
      'github issues action "labeled" is not mapped',
    );
  });
});

describe('github parse: release', () => {
  it('maps release.published', () => {
    const event = expectEvent(parse(readFixture('github/release-published.json'), on('release')));
    expect(event.type).toBe('github.release.published');
    expect(event.facts).toStrictEqual({ repo: 'acme/web' });
    expect(event.message).toStrictEqual({
      title: 'Release v1.4.0 · acme/web',
      url: 'https://github.com/acme/web/releases/tag/v1.4.0',
      severity: 'success',
      fields: [],
      actor,
      footer: 'GitHub · acme/web',
    });
  });

  it('ignores other actions', () => {
    const body = patchFixture('github/release-published.json', { action: 'created' });
    expect(expectIgnored(parse(body, on('release')))).toBe('github release action "created" is not mapped');
  });
});

describe('github parse: workflow_run', () => {
  const run = {
    url: 'https://github.com/acme/web/actions/runs/30433642',
    fields: [{ name: 'Branch', value: '`main`', inline: true }],
    actor,
    footer: 'GitHub · acme/web',
  };
  const facts = { repo: 'acme/web', branch: 'main', workflow: 'CI' };

  it('maps a failed run', () => {
    const event = expectEvent(parse(readFixture('github/workflow-run-failure.json'), on('workflow_run')));
    expect(event.type).toBe('github.workflow_run.failed');
    expect(event.facts).toStrictEqual(facts);
    expect(event.message).toStrictEqual({ title: 'CI failed: CI · acme/web', severity: 'error', ...run });
  });

  it('maps a successful run', () => {
    const event = expectEvent(parse(readFixture('github/workflow-run-success.json'), on('workflow_run')));
    expect(event.type).toBe('github.workflow_run.succeeded');
    expect(event.facts).toStrictEqual(facts);
    expect(event.message).toStrictEqual({ title: 'CI succeeded: CI · acme/web', severity: 'success', ...run });
  });

  it('omits the branch when the run has none', () => {
    const body = patchFixture('github/workflow-run-failure.json', { 'workflow_run.head_branch': null });
    const event = expectEvent(parse(body, on('workflow_run')));
    expect(event.facts).toStrictEqual({ repo: 'acme/web', workflow: 'CI' });
    expect(event.message.fields).toStrictEqual([]);
  });

  it.each(['timed_out', 'startup_failure'])('maps a %s run as failed', conclusion => {
    const body = patchFixture('github/workflow-run-failure.json', { 'workflow_run.conclusion': conclusion });
    const event = expectEvent(parse(body, on('workflow_run')));
    expect(event.type).toBe('github.workflow_run.failed');
    expect(event.message.severity).toBe('error');
  });

  it('falls back on an empty workflow name and omits an empty branch', () => {
    const body = patchFixture('github/workflow-run-failure.json', {
      'workflow_run.name': '',
      'workflow_run.head_branch': '',
    });
    const event = expectEvent(parse(body, on('workflow_run')));
    expect(event.facts).toStrictEqual({ repo: 'acme/web', workflow: 'workflow' });
    expect(event.message.title).toBe('CI failed: workflow · acme/web');
  });

  it('ignores other conclusions and actions', () => {
    expect(expectIgnored(parse(readFixture('github/workflow-run-cancelled.json'), on('workflow_run')))).toBe(
      'github workflow_run conclusion "cancelled" is not mapped',
    );
    expect(expectIgnored(parse(readFixture('github/workflow-run-requested.json'), on('workflow_run')))).toBe(
      'github workflow_run action "requested" is not mapped',
    );
  });
});

describe('github parse: everything else', () => {
  it('ignores ping', () => {
    expect(expectIgnored(parse(readFixture('github/ping.json'), on('ping')))).toBe('ping');
  });

  it.each(PROTOTYPE_KEYS)('never resolves the prototype member %s as an event name', key => {
    expect(expectIgnored(parse(readFixture('github/push.json'), on(key)))).toBe(`github event "${key}" is not mapped`);
  });

  it('strips NUL and lone surrogates from JSON escapes', () => {
    const body = String.raw`{"action":"opened","repository":{"full_name":"acme/web\u0000"},"pull_request":{"number":1,"title":"Fix\ud800","html_url":"https://github.com/acme/web/pull/1","base":{"ref":"main\udc00"}}}`;
    const event = expectEvent(parse(body, on('pull_request')));
    expect(event.facts).toStrictEqual({ repo: 'acme/web', baseBranch: 'main�' });
    expect(event.message.title).toBe('PR opened: Fix� · acme/web');
    const action = String.raw`{"action":"x\u0000\ud800","repository":{"full_name":"a/b"},"issue":{"number":1,"title":"t","html_url":"https://github.com/a/b/issues/1"}}`;
    expect(expectIgnored(parse(action, on('issues')))).toBe('github issues action "x�" is not mapped');
  });

  it('ignores unmapped events, naming them', () => {
    expect(expectIgnored(parse(readFixture('github/star-created.json'), on('star')))).toBe(
      'github event "star" is not mapped',
    );
  });

  it('ignores a request without an event header', () => {
    expect(expectIgnored(parse(readFixture('github/push.json'), new Headers()))).toBe('missing X-GitHub-Event header');
  });

  it('ignores malformed JSON and payloads that do not match', () => {
    expect(expectIgnored(parse('{nope', on('push')))).toBe('malformed JSON body');
    expect(expectIgnored(parse('{"ref":"refs/heads/main"}', on('push')))).toBe(
      'github push payload does not match the expected shape',
    );
    expect(expectIgnored(parse('{"action":"opened"}', on('pull_request')))).toBe(
      'github pull_request payload does not match the expected shape',
    );
  });
});

describe('github sourceEvent', () => {
  it('is <event>.<action>, or the event alone when the body has no action', () => {
    expect(sourceEvent(readFixture('github/pull-request-opened.json'), on('pull_request'))).toBe('pull_request.opened');
    expect(sourceEvent(readFixture('github/push.json'), on('push'))).toBe('push');
  });

  it('is undefined without the event header, and sanitized', () => {
    expect(sourceEvent(readFixture('github/push.json'), new Headers())).toBeUndefined();
    expect(sourceEvent(JSON.stringify({ action: 'a\u{0}b' }), on('issues'))).toBe('issues.ab');
  });
});
