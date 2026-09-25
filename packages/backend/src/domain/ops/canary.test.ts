import { randomUUID } from 'node:crypto';

import { InboundEventTypes } from '@mocco/common/inbound';
import { describe, expect, it } from 'vitest';

import { sourceAdapters } from '@backend/domain/inbound/sources/adapters';
import { ParsedInboundKinds } from '@backend/domain/inbound/sources/shared';
import { buildCanaryRequest, canaryIdAt, canaryIngestUrl, stage0CanaryMatcher } from '@backend/domain/ops/canary';
import { stage0ConfigFromEnv } from '@backend/domain/ops/config';
import { CanaryReasons, Stage0Canary } from '@backend/domain/ops/constants';

const KEY = 'k'.repeat(43);
const SECRET = 'canary-secret';

describe('canary id', () => {
  it('is stage0- and the ISO minute', () => {
    expect(canaryIdAt(new Date('2026-09-25T10:05:42.123Z'))).toBe('stage0-2026-09-25T10:05Z');
  });
});

describe('buildCanaryRequest', () => {
  const request = buildCanaryRequest({
    canaryId: 'stage0-2026-09-25T10:05Z',
    secret: SECRET,
    appOrigin: 'https://www.mocco.test',
  });
  const { github } = sourceAdapters;
  const text = new TextDecoder().decode(request.body);

  it('is signed the way GitHub signs, over the exact bytes', () => {
    expect(github.verify(request.body, request.headers, SECRET)).toBe(true);
    expect(github.verify(request.body, request.headers, 'another-secret')).toBe(false);
    expect(request.headers.get('x-github-delivery')).toBe('stage0-2026-09-25T10:05Z');
  });

  it('maps to github.workflow_run.succeeded, marked as the canary', () => {
    const parsed = github.parse(text, request.headers);

    expect(parsed).toMatchObject({
      kind: ParsedInboundKinds.event,
      type: InboundEventTypes['github.workflow_run.succeeded'],
      facts: { repo: Stage0Canary.repo, workflow: Stage0Canary.workflow, branch: 'stage0-2026-09-25T10:05Z' },
    });
    expect(github.deliveryId(text, request.headers)).toBe('stage0-2026-09-25T10:05Z');
  });
});

describe('canaryIngestUrl (the SSRF guard)', () => {
  it('builds the ingest URL on SERVICE_DOMAIN', () => {
    expect(canaryIngestUrl('www.mocco.club', KEY)).toEqual({ url: `https://www.mocco.club/api/ext/inbound/${KEY}` });
    expect(canaryIngestUrl('localhost:3100', KEY)).toEqual({ url: `http://localhost:3100/api/ext/inbound/${KEY}` });
  });

  it('refuses without SERVICE_DOMAIN', () => {
    expect(canaryIngestUrl(undefined, KEY)).toEqual({ refused: CanaryReasons.noServiceDomain });
  });

  it.each([
    ['userinfo that moves the host', 'www.mocco.club@evil.test'],
    ['a path', 'www.mocco.club/evil'],
    ['a query', 'www.mocco.club?x=1'],
    ['a fragment', 'www.mocco.club#x'],
    ['an explicit default port', 'www.mocco.club:443'],
    ['a scheme', 'https://www.mocco.club'],
  ])('refuses a SERVICE_DOMAIN with %s', (_label, domain) => {
    expect(canaryIngestUrl(domain, KEY)).toEqual({ refused: CanaryReasons.foreignHost });
  });

  it.each([['../../evil'], ['a/b'], ['short']])('refuses a malformed ingest key %s', key => {
    expect(canaryIngestUrl('www.mocco.club', key)).toEqual({ refused: CanaryReasons.malformedIngestKey });
  });
});

describe('stage0CanaryMatcher', () => {
  const sourceId = randomUUID();
  const isCanary = stage0CanaryMatcher(sourceId);
  const canary = {
    type: InboundEventTypes['github.workflow_run.succeeded'],
    payload: { sourceId, facts: { repo: 'mocco/stage0', workflow: Stage0Canary.workflow, branch: 'stage0-x' } },
  };

  it('matches the canary source, type and workflow', () => {
    expect(isCanary(canary)).toBe(true);
  });

  it('ignores the same run from another source (another workspace cannot spoof it)', () => {
    expect(isCanary({ ...canary, payload: { ...canary.payload, sourceId: randomUUID() } })).toBe(false);
  });

  it('ignores another type, workflow or branch on the canary source', () => {
    expect(isCanary({ ...canary, type: InboundEventTypes['github.workflow_run.failed'] })).toBe(false);
    expect(isCanary({ ...canary, payload: { ...canary.payload, facts: { workflow: 'CI', branch: 'stage0-x' } } })).toBe(
      false,
    );
    expect(
      isCanary({
        ...canary,
        payload: { ...canary.payload, facts: { workflow: Stage0Canary.workflow, branch: 'main' } },
      }),
    ).toBe(false);
    expect(isCanary({ type: 'gate.pending', payload: { facts: {} } })).toBe(false);
  });
});

describe('stage0ConfigFromEnv', () => {
  const sourceId = randomUUID();

  it('is off unless both OPS vars are set', () => {
    expect(stage0ConfigFromEnv({})).toBeUndefined();
    expect(stage0ConfigFromEnv({ OPS_CANARY_SOURCE_ID: sourceId })).toBeUndefined();
    expect(stage0ConfigFromEnv({ OPS_HEARTBEAT_URL: 'https://hc-ping.com/x' })).toBeUndefined();
  });

  it('carries SERVICE_DOMAIN when both are set', () => {
    expect(
      stage0ConfigFromEnv({
        OPS_CANARY_SOURCE_ID: sourceId,
        OPS_HEARTBEAT_URL: 'https://hc-ping.com/x',
        SERVICE_DOMAIN: 'www.mocco.club',
      }),
    ).toEqual({ canarySourceId: sourceId, heartbeatUrl: 'https://hc-ping.com/x', serviceDomain: 'www.mocco.club' });
  });
});
