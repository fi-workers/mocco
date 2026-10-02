// The restricted JsonLogic subset Mocco's rulesets use (ADR 0024). Only these operators
// exist; anything else is refused by `validateLogic` before a ruleset is used, and by
// `applyLogic` if it slips through. The semantics follow json-logic-js, plus flagd's
// custom operators (`fractional`, `sem_ver`, `starts_with`, `ends_with`), so a ruleset
// evaluates the same here as in flagd.
import { murmur3 } from './murmur3';
import { semverMatches } from './semver';

/** The flagd properties every evaluation context carries (`$flagd.flagKey`, `$flagd.timestamp`). */
export const FLAGD_PROPERTIES_KEY = '$flagd';

/** The largest total weight flagd accepts in a `fractional`. */
const MAX_TOTAL_WEIGHT = 0x7f_ff_ff_ff;

export class LogicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogicError';
  }
}

type Data = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The operator of an operation node (an object with exactly one key), else undefined. */
function operatorOf(rule: unknown): string | undefined {
  if (!isPlainObject(rule)) {
    return undefined;
  }
  const keys = Object.keys(rule);
  return keys.length === 1 ? keys[0] : undefined;
}

/** json-logic truthiness: an empty array is false, everything else as JavaScript. */
export function isTruthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/** A missing `var` path: the whole data object. */
const isWholeData = (path: unknown): boolean => path === undefined || path === null || String(path) === '';

/** A `var` path that leads nowhere. */
const MISSING = Symbol('missing');

function readVar(data: unknown, path: unknown, fallback: unknown = null): unknown {
  if (isWholeData(path)) {
    return data;
  }
  const found = String(path)
    .split('.')
    // eslint-disable-next-line sonarjs/function-return-type -- a value, or the MISSING sentinel
    .reduce<unknown>((current, segment) => {
      if (current === MISSING || typeof current !== 'object' || current === null) {
        return MISSING;
      }
      const next = (current as Record<string, unknown>)[segment];
      return next === undefined ? MISSING : next;
    }, data);
  return found === MISSING ? fallback : found;
}

/** JavaScript's relational comparison: lexical for two strings, numeric otherwise. */
function isBefore(left: unknown, right: unknown, isEqualAllowed: boolean): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    return isEqualAllowed ? left <= right : left < right;
  }
  return isEqualAllowed ? Number(left) <= Number(right) : Number(left) < Number(right);
}

/** JavaScript's loose equality, as json-logic-js uses for `==`. */
function isLooselyEqual(left: unknown, right: unknown): boolean {
  // eslint-disable-next-line eqeqeq -- json-logic's == is JavaScript's loose equality by definition
  return left == right;
}

/** The bucketing key and distribution entries of a `fractional`, or null for no result. */
// eslint-disable-next-line sonarjs/function-return-type -- null is the "no targeting key" answer
function fractionalInput(args: unknown[], data: Data): { bucketBy: string; entries: unknown[] } | null {
  const [first, ...rest] = args;
  if (typeof first === 'string') {
    return { bucketBy: first, entries: rest };
  }
  const { targetingKey } = data;
  if (typeof targetingKey !== 'string' || targetingKey === '') {
    return null;
  }
  const flagd = data[FLAGD_PROPERTIES_KEY];
  const flagKey = isPlainObject(flagd) && typeof flagd.flagKey === 'string' ? flagd.flagKey : '';
  return { bucketBy: `${flagKey}${targetingKey}`, entries: first === null || first === undefined ? rest : args };
}

/**
 * flagd's `fractional`: an optional bucketing value (a string) followed by
 * `[variant, weight?]` entries. Without a bucketing value the key is
 * `$flagd.flagKey + targetingKey`, and no targeting key means no result (null). The
 * bucket is `(murmur3(key) * totalWeight) >> 32`; variants keep their order, so raising a
 * weight only moves keys into that variant.
 */
function fractional(args: unknown[], data: Data): unknown {
  const input = args.length === 0 ? null : fractionalInput(args, data);
  if (input === null) {
    return null;
  }
  const weighted = input.entries.map(entry => {
    if (!Array.isArray(entry) || entry.length === 0) {
      throw new LogicError('fractional: each distribution is [variant, weight?]');
    }
    const [variant, weight = 1] = entry as [unknown, unknown?];
    if (typeof weight !== 'number' || !Number.isSafeInteger(weight)) {
      throw new LogicError('fractional: weights must be integers');
    }
    return { variant, weight: Math.max(0, weight) };
  });
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight === 0 || totalWeight > MAX_TOTAL_WEIGHT) {
    return null;
  }
  // (hash * totalWeight) >> 32, in exact integer arithmetic.
  const bucket = Number((BigInt(murmur3(input.bucketBy)) * BigInt(totalWeight)) / 2n ** 32n);
  let rangeEnd = 0;
  const chosen = weighted.find(entry => {
    rangeEnd += entry.weight;
    return bucket < rangeEnd;
  });
  return chosen?.variant ?? null;
}

/** `[string, string]` arguments, or null. */
function stringPair(args: unknown[]): [string, string] | null {
  const [value, target] = args;
  return args.length === 2 && typeof value === 'string' && typeof target === 'string' ? [value, target] : null;
}

type Operation = (args: unknown[], data: Data) => unknown;

/** The eager operators: their arguments are evaluated first. */
const OPERATIONS: Record<string, Operation> = {
  '!': ([value]) => !isTruthy(value),
  '==': ([left, right]) => isLooselyEqual(left, right),
  '!=': ([left, right]) => !isLooselyEqual(left, right),
  '<': ([low, value, high]) =>
    high === undefined ? isBefore(low, value, false) : isBefore(low, value, false) && isBefore(value, high, false),
  '<=': ([low, value, high]) =>
    high === undefined ? isBefore(low, value, true) : isBefore(low, value, true) && isBefore(value, high, true),
  // a > b is b < a.
  '>': ([greater, lesser]) => isBefore(lesser, greater, false),
  '>=': ([greater, lesser]) => isBefore(lesser, greater, true),
  in: ([needle, haystack]) => {
    if (typeof haystack === 'string') {
      // eslint-disable-next-line sonarjs/null-dereference -- narrowed to a string on the line above
      return haystack.includes(String(needle));
    }
    return Array.isArray(haystack) && haystack.includes(needle);
  },
  var: ([path, fallback], data) => readVar(data, path, fallback ?? null),
  cat: args => args.map(String).join(''),
  starts_with: args => {
    const pair = stringPair(args);
    return pair === null ? null : pair[0].startsWith(pair[1]);
  },
  ends_with: args => {
    const pair = stringPair(args);
    return pair === null ? null : pair[0].endsWith(pair[1]);
  },
  sem_ver: args => (args.length === 3 ? semverMatches(args[0], args[1], args[2]) : null),
  fractional,
};

/** The lazy operators, which evaluate only the branches they need. */
const LAZY_OPERATORS = ['if', 'and', 'or'] as const;

export const LOGIC_OPERATORS: readonly string[] = [...LAZY_OPERATORS, ...Object.keys(OPERATIONS)];
const OPERATORS = new Set(LOGIC_OPERATORS);

/** The problems with a rule: operators outside the subset, malformed nodes. Empty when usable. */
export function validateLogic(rule: unknown, path = 'targeting'): string[] {
  if (Array.isArray(rule)) {
    return rule.flatMap((item, index) => validateLogic(item, `${path}[${index}]`));
  }
  if (!isPlainObject(rule) || Object.keys(rule).length === 0) {
    return [];
  }
  const operator = operatorOf(rule);
  if (operator === undefined) {
    return [`${path}: an operation has exactly one operator`];
  }
  return OPERATORS.has(operator)
    ? validateLogic(rule[operator], `${path}.${operator}`)
    : [`${path}: "${operator}" isn't a supported operator`];
}

/** Evaluate `rule` against `data`. Throws `LogicError` for an operator outside the subset. */
export function applyLogic(rule: unknown, data: Data): unknown {
  if (Array.isArray(rule)) {
    return rule.map(item => applyLogic(item, data));
  }
  const operator = operatorOf(rule);
  if (operator === undefined || !isPlainObject(rule)) {
    return rule;
  }
  const raw = rule[operator];
  const values = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  const evaluate = (value: unknown) => applyLogic(value, data);

  if (operator === 'if') {
    const pairs = Math.floor(values.length / 2);
    const taken = Array.from({ length: pairs }, (_, index) => index * 2).find(index =>
      isTruthy(evaluate(values[index])),
    );
    if (taken !== undefined) {
      return evaluate(values[taken + 1]);
    }
    return values.length % 2 === 1 ? evaluate(values.at(-1)) : null;
  }
  if (operator === 'and' || operator === 'or') {
    // `and` stops at the first falsy value, `or` at the first truthy one; else the last value.
    const isOr = operator === 'or';
    return values.reduce<{ isDone: boolean; value: unknown }>(
      (state, item) => {
        if (state.isDone) {
          return state;
        }
        const value = evaluate(item);
        return { isDone: isTruthy(value) === isOr, value };
      },
      { isDone: false, value: null },
    ).value;
  }
  const operation = Object.hasOwn(OPERATIONS, operator) ? OPERATIONS[operator] : undefined;
  if (operation === undefined) {
    throw new LogicError(`"${operator}" isn't a supported operator`);
  }
  return operation(
    values.map(value => evaluate(value)),
    data,
  );
}
