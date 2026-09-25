import { describe, expect, it } from 'vitest';

import {
  DomainEventTypes,
  domainEventPayloadSchemas,
  gateResumedPayloadSchema,
  isDomainEventType,
  isEventPatternMatch,
  runEventPayloadSchema,
} from './events';

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
    expect(runEventPayloadSchema.parse({ ...RUN_SUBJECT, facts })).toEqual({ ...RUN_SUBJECT, facts });
    expect(runEventPayloadSchema.safeParse({ ...RUN_SUBJECT, facts: { repo: 'x' } }).success).toBe(false);
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
