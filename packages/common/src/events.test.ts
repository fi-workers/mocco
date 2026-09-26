import { describe, expect, it } from 'vitest';

import {
  DomainEventTypes,
  domainEventPayloadSchemas,
  gatePendingPayloadSchema,
  gateResumedPayloadSchema,
  inboundEventPayloadSchema,
  isDomainEventType,
  isEventPatternMatch,
  runEventPayloadSchema,
  runFailedPayloadSchema,
} from './events';
import { InboundEventTypes } from './inbound';

const RUN_SUBJECT = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  repoFullName: 'fi-workers/api',
  pipelineName: 'deploy',
  commitSha: 'abc123',
  linkPath: '/workspaces/11111111-1111-4111-8111-111111111111/runs/22222222-2222-4222-8222-222222222222',
};

describe('domain event catalog', () => {
  it('has a payload schema for every type', () => {
    expect(new Set(Object.keys(domainEventPayloadSchemas))).toEqual(new Set(Object.values(DomainEventTypes)));
  });

  it('recognizes catalog types only', () => {
    expect(isDomainEventType(DomainEventTypes.gatePending)).toBe(true);
    expect(isDomainEventType('gate.unknown')).toBe(false);
    expect(isDomainEventType('toString')).toBe(false);
  });

  it('parses a run payload and rejects a missing fact', () => {
    const facts = { repo: 'fi-workers/api', pipeline: 'deploy' };
    expect(runEventPayloadSchema.parse({ ...RUN_SUBJECT, facts })).toMatchObject({ ...RUN_SUBJECT, facts });
    expect(runEventPayloadSchema.safeParse({ ...RUN_SUBJECT, facts: { repo: 'x' } }).success).toBe(false);
  });

  it('defaults the fields added after the first release, so older stored payloads still parse', () => {
    const facts = { repo: 'fi-workers/api', pipeline: 'deploy' };
    expect(runEventPayloadSchema.parse({ ...RUN_SUBJECT, facts })).toMatchObject({
      triggeredByUserId: null,
      triggeredByName: null,
    });
    expect(runFailedPayloadSchema.parse({ ...RUN_SUBJECT, facts })).toMatchObject({ failedStep: null, logsUrl: null });
    expect(
      gatePendingPayloadSchema.parse({
        ...RUN_SUBJECT,
        gateName: 'prod',
        gateItemIndex: 1,
        facts: { ...facts, gate: 'prod' },
      }).requirements,
    ).toEqual([]);
  });

  it('carries the failed step and the gate requirements when known', () => {
    const facts = { repo: 'fi-workers/api', pipeline: 'deploy' };
    const failed = runFailedPayloadSchema.parse({
      ...RUN_SUBJECT,
      facts,
      failedStep: { name: 'build', index: 0 },
      logsUrl: 'https://logs.test/0',
    });
    expect(failed).toMatchObject({ failedStep: { name: 'build', index: 0 }, logsUrl: 'https://logs.test/0' });
    const pending = gatePendingPayloadSchema.parse({
      ...RUN_SUBJECT,
      gateName: 'prod',
      gateItemIndex: 1,
      facts: { ...facts, gate: 'prod' },
      requirements: [{ role: 'sre', count: 2 }],
    });
    expect(pending.requirements).toEqual([{ role: 'sre', count: 2 }]);
  });

  it('requires the resuming principals on gate.resumed', () => {
    const gate = {
      ...RUN_SUBJECT,
      gateName: 'prod',
      gateItemIndex: 1,
      facts: { repo: 'fi-workers/api', pipeline: 'deploy', gate: 'prod' },
      actorUserId: '33333333-3333-4333-8333-333333333333',
    };
    expect(gateResumedPayloadSchema.safeParse(gate).success).toBe(false);
    expect(
      gateResumedPayloadSchema.safeParse({ ...gate, resumedBy: [{ userId: gate.actorUserId, role: 'sre' }] }).success,
    ).toBe(true);
  });
});

describe('isEventPatternMatch', () => {
  it('matches an exact type', () => {
    expect(isEventPatternMatch('gate.pending', 'gate.pending')).toBe(true);
    expect(isEventPatternMatch('gate.pending', 'gate.resumed')).toBe(false);
  });

  it('matches every type under a wildcard prefix, and only those', () => {
    expect(isEventPatternMatch('gate.*', 'gate.pending')).toBe(true);
    expect(isEventPatternMatch('gate.*', 'run.failed')).toBe(false);
    expect(isEventPatternMatch('github.pull_request.*', 'github.pull_request.opened')).toBe(true);
    expect(isEventPatternMatch('github.pull_request.*', 'github.push')).toBe(false);
    expect(isEventPatternMatch('gate.*', 'gateway.opened')).toBe(false);
  });
});

describe('inbound event types', () => {
  const payload = {
    sourceId: '33333333-3333-4333-8333-333333333333',
    facts: { repo: 'acme/web', hasCommits: true },
    message: { title: '2 commits · acme/web:main', severity: 'info', fields: [], footer: 'GitHub · acme/web' },
  };

  it('are all in the catalog with the shared inbound payload', () => {
    const types = Object.values(InboundEventTypes);
    expect(types).toHaveLength(16);
    expect(types.every(type => isDomainEventType(type))).toBe(true);
    expect(types.every(type => domainEventPayloadSchemas[type] === inboundEventPayloadSchema)).toBe(true);
  });

  it('parses { sourceId, facts, message } and rejects a non-uuid source or a nested fact', () => {
    expect(inboundEventPayloadSchema.parse(payload)).toEqual(payload);
    expect(inboundEventPayloadSchema.safeParse({ ...payload, sourceId: 'x' }).success).toBe(false);
    expect(inboundEventPayloadSchema.safeParse({ ...payload, facts: { repo: { name: 'x' } } }).success).toBe(false);
    expect(inboundEventPayloadSchema.safeParse({ ...payload, message: { title: '' } }).success).toBe(false);
  });
});
