import { describe, expect, it } from 'vitest';

import {
  explainNoMatch,
  isRuleMatch,
  type MatchableEvent,
  type MatchableRule,
} from '@backend/domain/notification/rules';

const SOURCE_A = '11111111-1111-4111-8111-111111111111';
const SOURCE_B = '22222222-2222-4222-8222-222222222222';

const rule = (overrides: Partial<MatchableRule> = {}): MatchableRule => ({
  eventType: 'vercel.deployment.succeeded',
  sourceId: null,
  filter: {},
  ...overrides,
});

const deployment: MatchableEvent = {
  type: 'vercel.deployment.succeeded',
  facts: { project: 'web', target: 'production', branch: 'main' },
  sourceId: SOURCE_A,
};

describe('isRuleMatch', () => {
  it('matches an exact type', () => {
    expect(isRuleMatch(rule(), deployment)).toBe(true);
    expect(isRuleMatch(rule({ eventType: 'vercel.deployment.error' }), deployment)).toBe(false);
  });

  it('matches a prefix wildcard only under its prefix', () => {
    expect(isRuleMatch(rule({ eventType: 'vercel.*' }), deployment)).toBe(true);
    expect(isRuleMatch(rule({ eventType: 'vercel.deployment.*' }), deployment)).toBe(true);
    expect(isRuleMatch(rule({ eventType: 'github.*' }), deployment)).toBe(false);
    // `vercel.*` must not match a type that only starts with the same letters.
    expect(isRuleMatch(rule({ eventType: 'verc.*' }), deployment)).toBe(false);
  });

  it('requires every filter key to equal the fact', () => {
    expect(isRuleMatch(rule({ filter: { target: 'production' } }), deployment)).toBe(true);
    expect(isRuleMatch(rule({ filter: { target: 'production', branch: 'main' } }), deployment)).toBe(true);
    expect(isRuleMatch(rule({ filter: { target: 'preview' } }), deployment)).toBe(false);
    expect(isRuleMatch(rule({ filter: { missing: 'x' } }), deployment)).toBe(false);
  });

  it('compares booleans strictly (true is not "true")', () => {
    const push: MatchableEvent = { type: 'github.push', facts: { hasCommits: true } };
    expect(isRuleMatch(rule({ eventType: 'github.push', filter: { hasCommits: true } }), push)).toBe(true);
    expect(isRuleMatch(rule({ eventType: 'github.push', filter: { hasCommits: 'true' } }), push)).toBe(false);
    expect(isRuleMatch(rule({ eventType: 'github.push', filter: { hasCommits: false } }), push)).toBe(false);
  });

  it('limits a rule with a source to that source', () => {
    expect(isRuleMatch(rule({ sourceId: SOURCE_A }), deployment)).toBe(true);
    expect(isRuleMatch(rule({ sourceId: SOURCE_B }), deployment)).toBe(false);
    // A governance event has no source: a source-bound rule never matches it.
    const gate: MatchableEvent = { type: 'gate.pending', facts: { repo: 'a/b' } };
    expect(isRuleMatch(rule({ eventType: 'gate.pending', sourceId: SOURCE_A }), gate)).toBe(false);
    expect(isRuleMatch(rule({ eventType: 'gate.pending' }), gate)).toBe(true);
  });
});

describe('explainNoMatch', () => {
  it('says when a channel has no rules', () => {
    expect(explainNoMatch([], deployment)).toBe('the channel has no rules');
  });

  it('says when no rule is for the event type', () => {
    expect(
      explainNoMatch([rule({ eventType: 'github.*' }), rule({ eventType: 'sentry.issue.created' })], deployment),
    ).toBe('no rule for `vercel.deployment.succeeded`');
  });

  it('names the filter value a rule for the type was missing', () => {
    const preview: MatchableEvent = { ...deployment, facts: { ...deployment.facts, target: 'preview' } };
    expect(explainNoMatch([rule({ filter: { target: 'production' } })], preview)).toBe(
      'rule `vercel.deployment.succeeded` needs target = "production" (the event has "preview")',
    );
    expect(explainNoMatch([rule({ filter: { region: 'eu' } })], deployment)).toBe(
      'rule `vercel.deployment.succeeded` needs region = "eu" (the event has no value)',
    );
  });

  it('explains a source mismatch and joins several reasons', () => {
    const rules = [rule({ sourceId: SOURCE_B }), rule({ eventType: 'vercel.*', filter: { branch: 'release' } })];
    expect(explainNoMatch(rules, deployment)).toBe(
      'rule `vercel.deployment.succeeded` is limited to another source; rule `vercel.*` needs branch = "release" (the event has "main")',
    );
  });

  it('agrees with isRuleMatch when a rule matches', () => {
    expect(explainNoMatch([rule({ eventType: 'github.*' }), rule({ eventType: 'vercel.*' })], deployment)).toBe(
      'rule `vercel.*` matches',
    );
  });
});
