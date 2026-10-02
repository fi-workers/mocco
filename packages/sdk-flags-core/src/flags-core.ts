// The public entry of @mocco/flags-core (the package's "exports" target).
export { ErrorCodes, Reasons, resolveFlag, resolveTyped } from './evaluate';
export type { ErrorCode, EvaluationContext, FlagValueType, Reason, Resolution, TypedResolution } from './evaluate';
export { applyLogic, isTruthy, LOGIC_OPERATORS, LogicError, validateLogic } from './json-logic';
export { murmur3 } from './murmur3';
export { parseRuleset } from './ruleset';
export type { FlagDefinition, FlagMetadata, Ruleset, RulesetCheck } from './ruleset';
export { compareVersions, parseVersion, semverMatches } from './semver';
