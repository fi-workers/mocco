// Editors for flag targeting (#140): clauses (attribute or segment), what a rule serves
// (a variant or a percentage rollout) and an ordered rule list. They edit drafts — text
// as typed — and `toRule` / `toClause` turn a draft into the wire shape on save, so the
// server's validation is the one source of truth for what is allowed.
import { ClauseOps, SINGLE_VALUE_OPS } from '@mocco/common/flags';

import { inputClass } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';

import type { AttributeClause, Clause, ClauseOp, RolloutEntry, Rule, Serve } from '@mocco/common/flags';

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

export const opLabels: Record<ClauseOp, string> = {
  [ClauseOps.in]: 'is one of',
  [ClauseOps.notIn]: 'is not one of',
  [ClauseOps.startsWith]: 'starts with',
  [ClauseOps.endsWith]: 'ends with',
  [ClauseOps.lt]: '<',
  [ClauseOps.lte]: '≤',
  [ClauseOps.gt]: '>',
  [ClauseOps.gte]: '≥',
  [ClauseOps.semverEq]: 'version =',
  [ClauseOps.semverLt]: 'version <',
  [ClauseOps.semverLte]: 'version ≤',
  [ClauseOps.semverGt]: 'version >',
  [ClauseOps.semverGte]: 'version ≥',
};

const NUMERIC_OPS = new Set<ClauseOp>([ClauseOps.lt, ClauseOps.lte, ClauseOps.gt, ClauseOps.gte]);

/** Comma-separated values as typed → the clause's values (numbers for numeric ops, and
 * for `in` / `not_in` a value that is a plain number). */
function parseValues(op: ClauseOp, text: string): (string | number)[] {
  // eslint-disable-next-line sonarjs/null-dereference -- text is the input's string value, never null
  const parts = SINGLE_VALUE_OPS.includes(op) ? [text.trim()] : text.split(',').map(part => part.trim());
  return parts
    .filter(part => part !== '')
    .map(part => (NUMERIC_OPS.has(op) && part !== '' && Number.isFinite(Number(part)) ? Number(part) : part));
}

export function toAttributeClause(draft: Extract<ClauseDraft, { kind: 'attribute' }>): AttributeClause {
  return { attribute: draft.attribute.trim(), op: draft.op, values: parseValues(draft.op, draft.values) };
}

export function toClause(draft: ClauseDraft): Clause {
  return draft.kind === 'segment' ? { segment: draft.segment, negate: draft.negate } : toAttributeClause(draft);
}

export function toServe(draft: ServeDraft): Serve {
  return draft.kind === 'variant' ? { variant: draft.variant } : { rollout: draft.rollout };
}

export function toRule(draft: RuleDraft): Rule {
  return { clauses: draft.clauses.map(clause => toClause(clause)), serve: toServe(draft.serve) };
}

export function clauseDraftOf(clause: Clause): ClauseDraft {
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

const smallInput = `${inputClass} h-8 py-1 text-xs`;

export function ClauseRow({
  draft,
  segmentKeys,
  onChange,
  onRemove,
}: {
  draft: ClauseDraft;
  /** Offer segment clauses (flag rules); null for attribute-only editors (segment rules). */
  segmentKeys: readonly string[] | null;
  onChange: (next: ClauseDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {segmentKeys === null ? null : (
        <select
          aria-label="Clause kind"
          value={draft.kind}
          className={smallInput}
          onChange={event => {
            onChange(
              event.target.value === 'segment'
                ? { id: draft.id, kind: 'segment', segment: segmentKeys[0] ?? '', negate: false }
                : emptyAttributeClause(),
            );
          }}>
          <option value="attribute">Attribute</option>
          <option value="segment" disabled={segmentKeys.length === 0}>
            Segment
          </option>
        </select>
      )}
      {draft.kind === 'attribute' ? (
        <>
          <input
            aria-label="Attribute"
            value={draft.attribute}
            placeholder="plan"
            className={`${smallInput} w-32 font-mono`}
            onChange={event => {
              onChange({ ...draft, attribute: event.target.value });
            }}
          />
          <select
            aria-label="Operator"
            value={draft.op}
            className={smallInput}
            onChange={event => {
              onChange({ ...draft, op: event.target.value as ClauseOp });
            }}>
            {Object.values(ClauseOps).map(op => (
              <option key={op} value={op}>
                {opLabels[op]}
              </option>
            ))}
          </select>
          <input
            aria-label="Values"
            value={draft.values}
            placeholder={SINGLE_VALUE_OPS.includes(draft.op) ? 'value' : 'pro, enterprise'}
            className={`${smallInput} min-w-40 flex-1 font-mono`}
            onChange={event => {
              onChange({ ...draft, values: event.target.value });
            }}
          />
        </>
      ) : (
        <>
          <select
            aria-label="Membership"
            value={draft.negate ? 'not' : 'in'}
            className={smallInput}
            onChange={event => {
              onChange({ ...draft, negate: event.target.value === 'not' });
            }}>
            <option value="in">is in</option>
            <option value="not">is not in</option>
          </select>
          <select
            aria-label="Segment"
            value={draft.segment}
            className={smallInput}
            onChange={event => {
              onChange({ ...draft, segment: event.target.value });
            }}>
            {(segmentKeys ?? []).map(key => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </>
      )}
      <Button variant="ghost" size="sm" aria-label="Remove condition" onClick={onRemove}>
        ×
      </Button>
    </div>
  );
}

/** A variant, or a percentage rollout across the variants (order is kept). */
export function ServeEditor({
  draft,
  variants,
  label,
  onChange,
}: {
  draft: ServeDraft;
  variants: readonly string[];
  label: string;
  onChange: (next: ServeDraft) => void;
}) {
  const total = draft.kind === 'rollout' ? draft.rollout.reduce((sum, entry) => sum + entry.weight, 0) : 0;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        aria-label={`${label}: kind`}
        value={draft.kind}
        className={smallInput}
        onChange={event => {
          onChange(
            event.target.value === 'rollout'
              ? {
                  kind: 'rollout',
                  rollout: variants.map((variant, index) => ({ variant, weight: index === 0 ? 100 : 0 })),
                }
              : { kind: 'variant', variant: variants[0] ?? '' },
          );
        }}>
        <option value="variant">a variant</option>
        <option value="rollout">a percentage rollout</option>
      </select>
      {draft.kind === 'variant' ? (
        <select
          aria-label={`${label}: variant`}
          value={draft.variant}
          className={`${smallInput} font-mono`}
          onChange={event => {
            onChange({ kind: 'variant', variant: event.target.value });
          }}>
          {variants.map(variant => (
            <option key={variant} value={variant}>
              {variant}
            </option>
          ))}
        </select>
      ) : (
        draft.rollout.map((entry, index) => (
          <label key={entry.variant} className="flex items-center gap-1 font-mono">
            {entry.variant}
            <input
              type="number"
              min={0}
              aria-label={`${label}: weight of ${entry.variant}`}
              value={entry.weight}
              className={`${smallInput} w-16`}
              onChange={event => {
                const weight = Math.max(0, Math.trunc(Number(event.target.value) || 0));
                onChange({
                  kind: 'rollout',
                  rollout: draft.rollout.map((other, position) => (position === index ? { ...other, weight } : other)),
                });
              }}
            />
            <span className="text-muted-foreground">
              {total > 0 ? `${Math.round((entry.weight / total) * 1000) / 10}%` : '—'}
            </span>
          </label>
        ))
      )}
    </div>
  );
}

function RuleCard({
  rule,
  position,
  variants,
  segmentKeys,
  onChange,
}: {
  rule: RuleDraft;
  position: number;
  variants: readonly string[];
  segmentKeys: readonly string[];
  onChange: (next: RuleDraft | null) => void;
}) {
  const setClause = (id: string, next: ClauseDraft | null) => {
    const clauses =
      next === null
        ? rule.clauses.filter(clause => clause.id !== id)
        : rule.clauses.map(clause => (clause.id === id ? next : clause));
    onChange({ ...rule, clauses });
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label={`Rule ${position}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Rule {position}: if all of</span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove rule ${position}`}
          onClick={() => {
            onChange(null);
          }}>
          Remove
        </Button>
      </div>
      {rule.clauses.map(clause => (
        <ClauseRow
          key={clause.id}
          draft={clause}
          segmentKeys={segmentKeys}
          onChange={next => {
            setClause(clause.id, next);
          }}
          onRemove={() => {
            setClause(clause.id, null);
          }}
        />
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="w-fit text-xs"
        onClick={() => {
          onChange({ ...rule, clauses: [...rule.clauses, emptyAttributeClause()] });
        }}>
        + Condition
      </Button>
      <ServeEditor
        label="then serve"
        draft={rule.serve}
        variants={variants}
        onChange={serve => {
          onChange({ ...rule, serve });
        }}
      />
    </div>
  );
}

/** An ordered list of rules: conditions (all must match) and what each serves. */
export function RulesEditor({
  rules,
  variants,
  segmentKeys,
  onChange,
}: {
  rules: RuleDraft[];
  variants: readonly string[];
  segmentKeys: readonly string[];
  onChange: (next: RuleDraft[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, index) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          position={index + 1}
          variants={variants}
          segmentKeys={segmentKeys}
          onChange={next => {
            onChange(
              next === null
                ? rules.filter(other => other.id !== rule.id)
                : rules.map(other => (other.id === rule.id ? next : other)),
            );
          }}
        />
      ))}
      <Button
        variant="outline"
        size="sm"
        className="w-fit text-xs"
        onClick={() => {
          onChange([
            ...rules,
            {
              id: draftId(),
              clauses: [emptyAttributeClause()],
              serve: { kind: 'variant', variant: variants[0] ?? '' },
            },
          ]);
        }}>
        + Rule
      </Button>
    </div>
  );
}
