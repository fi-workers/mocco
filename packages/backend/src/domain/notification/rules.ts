// The notification rule matcher (relay design §7), pure. The fan-out uses
// `isRuleMatch` to decide which channels get a delivery; the activity trace (§8)
// re-runs the same function through `explainNoMatch` to tell a customer why a
// channel got nothing, so the explanation can never disagree with the decision.
import { isEventPatternMatch } from '@mocco/common/events';
import { factsSchema } from '@mocco/common/inbound';
import { z } from 'zod';

import type { Facts } from '@mocco/common/inbound';
import type { RuleFilter } from '@mocco/common/notification';

/** The parts of a rule the matcher reads. */
export interface MatchableRule {
  /** An exact event type or a `prefix.*` wildcard. */
  eventType: string;
  /** Only events from this inbound source, when set. */
  sourceId: string | null;
  filter: RuleFilter;
}

/** The parts of an event the matcher reads: its type, facts and (inbound events only) source. */
export interface MatchableEvent {
  type: string;
  facts: Facts;
  sourceId?: string;
}

/** The part of an event payload rules read: every catalog payload carries flat `facts`;
 * inbound payloads add the `sourceId` that received them (relay design §4). */
export const matchablePayloadSchema = z.object({ facts: factsSchema, sourceId: z.string().optional() });

/** What the matcher reads from an event of `type` with `payload`, or undefined when the
 * payload has no facts (a stored payload that no longer parses). */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "cannot be read" answer
export function parseMatchableEvent(type: string, payload: unknown): MatchableEvent | undefined {
  const parsed = matchablePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }
  const { facts, sourceId } = parsed.data;
  return { type, facts, ...(sourceId !== undefined && { sourceId }) };
}

type RuleCheck = { matches: true } | { matches: false; reason: string };

function describeValue(value: string | boolean | undefined): string {
  if (value === undefined) {
    return 'no value';
  }
  return typeof value === 'string' ? `"${value}"` : String(value);
}

// eslint-disable-next-line sonarjs/function-return-type -- each branch is one member of the RuleCheck union
function checkRule(rule: MatchableRule, event: MatchableEvent): RuleCheck {
  if (!isEventPatternMatch(rule.eventType, event.type)) {
    return { matches: false, reason: `rule \`${rule.eventType}\` is for other events` };
  }
  if (rule.sourceId !== null && rule.sourceId !== event.sourceId) {
    return { matches: false, reason: `rule \`${rule.eventType}\` is limited to another source` };
  }
  const mismatch = Object.entries(rule.filter).find(([key, expected]) => event.facts[key] !== expected);
  if (mismatch !== undefined) {
    const [key, expected] = mismatch;
    return {
      matches: false,
      reason: `rule \`${rule.eventType}\` needs ${key} = ${describeValue(expected)} (the event has ${describeValue(event.facts[key])})`,
    };
  }
  return { matches: true };
}

/**
 * Does `rule` want `event`? Its type pattern matches (exact or `prefix.*`), its source
 * (when set) is the event's source, and every filter key equals the fact of the same name.
 */
export function isRuleMatch(rule: MatchableRule, event: MatchableEvent): boolean {
  return checkRule(rule, event).matches;
}

/**
 * Why none of a channel's `rules` matched `event`, in one sentence for the activity
 * trace. Rules for other event types are summarized; a rule for this type explains
 * the source or the filter value it was missing.
 */
export function explainNoMatch(rules: readonly MatchableRule[], event: MatchableEvent): string {
  if (rules.length === 0) {
    return 'the channel has no rules';
  }
  const checks = rules.map(rule => ({ rule, check: checkRule(rule, event) }));
  const matching = checks.find(({ check }) => check.matches);
  if (matching !== undefined) {
    return `rule \`${matching.rule.eventType}\` matches`;
  }
  const forType = checks.filter(({ rule }) => isEventPatternMatch(rule.eventType, event.type));
  if (forType.length === 0) {
    return `no rule for \`${event.type}\``;
  }
  return forType.map(({ check }) => (check.matches ? '' : check.reason)).join('; ');
}
