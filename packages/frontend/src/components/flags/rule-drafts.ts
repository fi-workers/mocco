// Drafts of flag targeting (#140) as the editors hold them — values as typed — and the
// conversions to and from the wire shapes. `toRule` / `toAttributeClause` run on save, so
// the server's validation stays the one source of truth for what is allowed.
import { ClauseOps, SINGLE_VALUE_OPS } from '@mocco/common/flags';

import type { AttributeClause, Clause, ClauseOp, Rule, RolloutEntry, Serve } from '@mocco/common/flags';

/** A client-only id, so list items keep their inputs when others are removed. */
export const draftId = (): string => crypto.randomUUID();

export type ClauseDraft = { id: string } & (
  | { kind: 'attribute'; attribute: string; op: ClauseOp; values: string }
  | { kind: 'segment'; segment: string; negate: boolean }
);

export type ServeDraft = { kind: 'variant'; variant: string } | { kind: 'rollout'; rollout: RolloutEntry[] };

export interface RuleDraft {
  id: string;
  clauses: ClauseDraft[];
  serve: ServeDraft;
}

const NUMERIC_OPS = new Set<ClauseOp>([ClauseOps.lt, ClauseOps.lte, ClauseOps.gt, ClauseOps.gte]);

/** Comma-separated values as typed → the clause's values (numbers for numeric ops, and
 * for `in` / `not_in` a value that is a plain number). */
function parseValues(op: ClauseOp, text: string): (string | number)[] {
  // eslint-disable-next-line sonarjs/null-dereference -- text is the input's string value, never null
  const parts = SINGLE_VALUE_OPS.includes(op) ? [text.trim()] : text.split(',').map(part => part.trim());
  const isNumeric = NUMERIC_OPS.has(op);
  return parts.flatMap(part => {
    if (part === '') {
      return [];
    }
    return [isNumeric && Number.isFinite(Number(part)) ? Number(part) : part];
  });
}

export function toAttributeClause(draft: Extract<ClauseDraft, { kind: 'attribute' }>): AttributeClause {
  return { attribute: draft.attribute.trim(), op: draft.op, values: parseValues(draft.op, draft.values) };
}

function toClause(draft: ClauseDraft): Clause {
  return draft.kind === 'segment' ? { segment: draft.segment, negate: draft.negate } : toAttributeClause(draft);
}

export function toServe(draft: ServeDraft): Serve {
  return draft.kind === 'variant' ? { variant: draft.variant } : { rollout: draft.rollout };
}

export function toRule(draft: RuleDraft): Rule {
  return { clauses: draft.clauses.map(clause => toClause(clause)), serve: toServe(draft.serve) };
}

function clauseDraftOf(clause: Clause): ClauseDraft {
  return 'segment' in clause
    ? { id: draftId(), kind: 'segment', segment: clause.segment, negate: clause.negate }
    : {
        id: draftId(),
        kind: 'attribute',
        attribute: clause.attribute,
        op: clause.op,
        values: clause.values.join(', '),
      };
}

export function ruleDraftOf(rule: Rule): RuleDraft {
  return {
    id: draftId(),
    clauses: rule.clauses.map(clause => clauseDraftOf(clause)),
    serve:
      'variant' in rule.serve
        ? { kind: 'variant', variant: rule.serve.variant }
        : { kind: 'rollout', rollout: rule.serve.rollout },
  };
}

export const emptyAttributeClause = (): ClauseDraft => ({
  id: draftId(),
  kind: 'attribute',
  attribute: '',
  op: ClauseOps.in,
  values: '',
});
