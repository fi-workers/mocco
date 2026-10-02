import { describe, expect, it } from 'vitest';

import { semverMatches } from './semver';

describe('sem_ver', () => {
  it.each([
    ['1.2.3', '=', 'v1.2.3', true],
    ['v1', '=', '1.0.0', true],
    ['1.2', '<', '1.10.0', true],
    ['1.0.0-alpha', '<', '1.0.0', true],
    ['1.0.0-alpha.1', '<', '1.0.0-alpha.beta', true],
    ['1.0.0-beta.2', '<', '1.0.0-beta.11', true],
    ['1.0.0-rc.1', '>', '1.0.0-beta.11', true],
    ['1.0.0+build.5', '=', '1.0.0', true],
    ['2.5.1', '>=', '2.5.1', true],
    ['2.5.1', '!=', '2.5.2', true],
    ['3.9.9', '^', '3.0.0', true],
    ['4.0.0', '^', '3.0.0', false],
    ['3.1.7', '~', '3.1.0', true],
    ['3.2.0', '~', '3.1.0', false],
  ])('%s %s %s → %s', (actual, operator, target, expected) => {
    expect(semverMatches(actual, operator, target)).toBe(expected);
  });

  it('is null for an invalid version or operator', () => {
    expect([
      semverMatches('v1.2.3.x', '=', '1.2.3'),
      semverMatches('01.2.3', '=', '1.2.3'),
      semverMatches('1.2-beta', '=', '1.2.0'),
      semverMatches('1.2.3', '===', '1.2.3'),
    ]).toEqual([null, null, null, null]);
  });
});
