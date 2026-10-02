/* eslint-disable sonarjs/null-dereference -- every value here is a typed string, never null */
// Semantic versions as flagd's `sem_ver` reads them (Go's golang.org/x/mod/semver): an
// optional `v`, then MAJOR, MAJOR.MINOR or MAJOR.MINOR.PATCH (shorthands mean .0), with
// an optional -prerelease and +build on the full form only. Build metadata is ignored.

interface Version {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

const NUMBER = /^(?:0|[1-9]\d*)$/u;
const IDENTIFIER = /^[0-9A-Za-z-]+$/u;

/** Parse a version, or null when it isn't one. */
// eslint-disable-next-line sonarjs/function-return-type -- null is the "not a version" answer
export function parseVersion(input: string): Version | null {
  const text = input.startsWith('v') || input.startsWith('V') ? input.slice(1) : input;
  const plus = text.indexOf('+');
  const withoutBuild = plus === -1 ? text : text.slice(0, plus);
  const build = plus === -1 ? null : text.slice(plus + 1);
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const parts = core.split('.');
  if (parts.length > 3 || parts.some(part => !NUMBER.test(part))) {
    return null;
  }
  // Shorthands carry no prerelease or build.
  if (parts.length < 3 && (prerelease !== null || build !== null)) {
    return null;
  }
  if (build !== null && build.split('.').some(part => !IDENTIFIER.test(part))) {
    return null;
  }
  const identifiers = prerelease === null ? [] : prerelease.split('.');
  const isValidPrerelease = identifiers.every(
    part => IDENTIFIER.test(part) && (!/^\d+$/u.test(part) || NUMBER.test(part)),
  );
  if (!isValidPrerelease) {
    return null;
  }
  const [major = '0', minor = '0', patch = '0'] = parts;
  return { major, minor, patch, prerelease: identifiers };
}

/** Compare two non-negative decimal strings without converting them to numbers. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareIdentifier(a: string, b: string): number {
  const isNumericA = /^\d+$/u.test(a);
  const isNumericB = /^\d+$/u.test(b);
  if (isNumericA && isNumericB) {
    return compareNumeric(a, b);
  }
  if (isNumericA !== isNumericB) {
    return isNumericA ? -1 : 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    // A release sorts after its prereleases.
    return Math.sign(b.length - a.length);
  }
  const shared = Math.min(a.length, b.length);
  const differing = Array.from({ length: shared }, (_, index) =>
    compareIdentifier(a[index] ?? '', b[index] ?? ''),
  ).find(result => result !== 0);
  return differing ?? Math.sign(a.length - b.length);
}

/** -1, 0 or 1, as `semver.Compare`. */
export function compareVersions(a: Version, b: Version): number {
  return (
    [compareNumeric(a.major, b.major), compareNumeric(a.minor, b.minor), compareNumeric(a.patch, b.patch)].find(
      result => result !== 0,
    ) ?? comparePrerelease(a.prerelease, b.prerelease)
  );
}

/**
 * flagd's `sem_ver`: `[version, operator, target]` with `=`, `!=`, `<`, `<=`, `>`, `>=`,
 * `^` (same major) or `~` (same major and minor). Null when an argument isn't valid.
 */
export function semverMatches(actual: unknown, operator: unknown, target: unknown): boolean | null {
  const left = parseVersion(String(actual));
  const right = parseVersion(String(target));
  if (left === null || right === null || typeof operator !== 'string') {
    return null;
  }
  const order = compareVersions(left, right);
  switch (operator) {
    case '=': {
      return order === 0;
    }
    case '!=': {
      return order !== 0;
    }
    case '<': {
      return order < 0;
    }
    case '<=': {
      return order <= 0;
    }
    case '>': {
      return order > 0;
    }
    case '>=': {
      return order >= 0;
    }
    case '^': {
      return left.major === right.major;
    }
    case '~': {
      return left.major === right.major && left.minor === right.minor;
    }
    default: {
      return null;
    }
  }
}
