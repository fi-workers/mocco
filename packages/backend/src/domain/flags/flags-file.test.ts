import { describe, expect, it } from 'vitest';

import { applyOps } from '@backend/domain/flags/apply-ops';
import { parseFlagsFile, planFlagsFile } from '@backend/domain/flags/flags-file';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';

import type { EnvironmentState, FlagConfigState } from '@backend/domain/flags/apply-ops';
import type { FlagsHead, HeadFlag } from '@backend/domain/flags/flags-file';
import type { FlagsFile } from '@mocco/common/flags-file';

const FILE = `
version: 1
flags:
  checkout_v2:
    description: New checkout flow
    targets:
      staging:
        default: on
      production:
        default: off
        rules:
          - when: { attribute: plan, op: in, values: [enterprise] }
            serve: on
          - when:
              - { segment: beta }
              - { attribute: country, op: in, values: [KR] }
            serve: { rollout: { on: 10, off: 90 } }
`;

const parsed = (source: string): FlagsFile => {
  const result = parseFlagsFile(source, decodeYaml);
  if (result.file === null) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.file;
};

const config = (overrides: Partial<FlagConfigState> = {}): FlagConfigState => ({
  enabled: false,
  killed: false,
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [],
  rollout: null,
  ...overrides,
});

const environment = (configs: Record<string, FlagConfigState> = {}, segments: string[] = []): EnvironmentState => ({
  configs: new Map(Object.entries(configs)),
  segments: new Map(segments.map(key => [key, { name: key, includedKeys: [], excludedKeys: [], rules: [] }])),
  variants: new Map(Object.keys(configs).map(key => [key, ['on', 'off']])),
});

const booleanFlag = (overrides: Partial<HeadFlag> = {}): HeadFlag => ({
  type: 'boolean',
  variants: { on: true, off: false },
  description: null,
  lifecycle: 'temporary',
  clientVisible: false,
  managedBy: 'repo',
  ...overrides,
});

const head = (flags: Record<string, HeadFlag>, environments: Record<string, EnvironmentState>): FlagsHead => ({
  flags: new Map(Object.entries(flags)),
  environments: new Map(Object.entries(environments)),
});

describe('parseFlagsFile', () => {
  it('reads a boolean flag with default variants and per-environment targets', () => {
    const file = parsed(FILE);

    expect(file.flags.checkout_v2).toMatchObject({ type: 'boolean', lifecycle: 'temporary', client_visible: false });
    expect(file.flags.checkout_v2?.targets.staging).toEqual({ enabled: true, default: 'on', rules: [] });
  });

  it('reports YAML errors with a line, unknown keys, and variants that do not exist', () => {
    const yaml = parseFlagsFile('version: 1\nflags: [', decodeYaml);
    const unknownKey = parseFlagsFile('version: 1\nflags:\n  a:\n    taregts: {}\n', decodeYaml);
    const missingVariant = parseFlagsFile(
      'version: 1\nflags:\n  a:\n    targets:\n      staging: { default: maybe }\n',
      decodeYaml,
    );
    const noVariants = parseFlagsFile('version: 1\nflags:\n  a:\n    type: string\n', decodeYaml);

    expect(yaml.file).toBeNull();
    expect(yaml.issues[0]?.line).toBeGreaterThan(0);
    expect(unknownKey.issues.map(issue => issue.path)).toEqual(['flags.a']);
    expect(missingVariant.issues.map(issue => issue.path)).toEqual(['flags.a.targets.staging.default']);
    expect(noVariants.issues.map(issue => issue.path)).toEqual(['flags.a.variants']);
  });
});

describe('planFlagsFile', () => {
  it('creates a new flag and plans one changeset per environment it changes', () => {
    const result = planFlagsFile(
      parsed(FILE),
      head({}, { staging: environment(), production: environment({}, ['beta']), qa: environment() }),
    );

    expect(result.issues).toEqual([]);
    const { plan } = result;
    expect(plan?.creations).toEqual([
      {
        key: 'checkout_v2',
        type: 'boolean',
        variants: { on: true, off: false },
        offVariant: 'off',
        description: 'New checkout flow',
        lifecycle: 'temporary',
        clientVisible: false,
      },
    ]);
    // qa isn't listed: the new flag stays off there, so qa has no changeset.
    expect(plan?.changes.map(change => change.environmentKey)).toEqual(['production', 'staging']);
    expect(plan?.changes.find(change => change.environmentKey === 'staging')?.ops).toEqual([
      { op: 'set_default_variant', flagKey: 'checkout_v2', variant: 'on' },
      { op: 'set_enabled', flagKey: 'checkout_v2', enabled: true },
    ]);
    expect(plan?.changes.find(change => change.environmentKey === 'production')?.ops).toEqual([
      {
        op: 'set_rules',
        flagKey: 'checkout_v2',
        rules: [
          { clauses: [{ attribute: 'plan', op: 'in', values: ['enterprise'] }], serve: { variant: 'on' } },
          {
            clauses: [
              { segment: 'beta', negate: false },
              { attribute: 'country', op: 'in', values: ['KR'] },
            ],
            serve: {
              rollout: [
                { variant: 'on', weight: 10 },
                { variant: 'off', weight: 90 },
              ],
            },
          },
        ],
      },
      { op: 'set_enabled', flagKey: 'checkout_v2', enabled: true },
    ]);
  });

  it('plans nothing when the project already matches, and a second sync is a no-op', () => {
    const file = parsed(FILE);
    const first = planFlagsFile(file, head({}, { staging: environment(), production: environment({}, ['beta']) }));
    const firstPlan = first.plan;
    if (firstPlan === null) {
      throw new Error('expected a plan');
    }
    const after = (key: string) => {
      const state = key === 'staging' ? environment() : environment({}, ['beta']);
      const configs = new Map([['checkout_v2', config()]]);
      const ops = firstPlan.changes.find(change => change.environmentKey === key)?.ops ?? [];
      const applied = applyOps({ ...state, configs, variants: new Map([['checkout_v2', ['on', 'off']]]) }, ops);
      return environment(
        { checkout_v2: applied.changed.get('checkout_v2') ?? config() },
        key === 'production' ? ['beta'] : [],
      );
    };

    const second = planFlagsFile(
      file,
      head(
        { checkout_v2: booleanFlag({ description: 'New checkout flow' }) },
        { staging: after('staging'), production: after('production') },
      ),
    );

    expect(second).toEqual({
      plan: { creations: [], definitionUpdates: [], adopted: [], released: [], changes: [] },
      issues: [],
    });
  });

  it('never restores a killed flag', () => {
    const file = parsed('version: 1\nflags:\n  pay:\n    targets:\n      production: { default: on }\n');
    const result = planFlagsFile(
      file,
      head({ pay: booleanFlag() }, { production: environment({ pay: config({ killed: true, enabled: true }) }) }),
    );

    const ops = result.plan?.changes.flatMap(change => change.ops) ?? [];
    expect(ops).toEqual([{ op: 'set_default_variant', flagKey: 'pay', variant: 'on' }]);
    expect(ops.some(op => op.op === 'restore' || op.op === 'kill')).toBe(false);
  });

  it('adopts console flags, adds variants, and releases repo flags the file dropped', () => {
    const file = parsed(
      'version: 1\nflags:\n  theme:\n    type: string\n    variants: { light: light, dark: dark, dim: dim }\n    off_variant: light\n    lifecycle: permanent\n',
    );
    const result = planFlagsFile(
      file,
      head(
        {
          theme: booleanFlag({ type: 'string', variants: { light: 'light', dark: 'dark' }, managedBy: 'ui' }),
          old: booleanFlag(),
        },
        {
          production: {
            ...environment({
              theme: config({ defaultVariant: 'light', offVariant: 'light' }),
              old: config({ enabled: true }),
            }),
          },
        },
      ),
    );

    expect(result.plan).toMatchObject({
      adopted: ['theme'],
      released: ['old'],
      definitionUpdates: [{ key: 'theme', lifecycle: 'permanent', addedVariants: { dim: 'dim' } }],
      changes: [{ environmentKey: 'production', ops: [{ op: 'set_enabled', flagKey: 'old', enabled: false }] }],
    });
  });

  it('answers every issue and no plan: a missing environment, a type change, a removed variant, a missing segment', () => {
    const file = parsed(`
version: 1
flags:
  a:
    targets:
      prod: { default: on }
  b:
    type: string
    variants: { x: x }
    off_variant: x
  c:
    variants: { on: true }
    off_variant: on
  d:
    targets:
      production:
        default: on
        rules:
          - when: { segment: nobody }
            serve: off
`);
    const result = planFlagsFile(
      file,
      head({ b: booleanFlag(), c: booleanFlag() }, { production: environment({ b: config(), c: config() }) }),
    );

    expect(result.plan).toBeNull();
    expect(result.issues.map(issue => issue.path)).toEqual([
      'flags.a.targets.prod',
      'flags.b.type',
      'flags.c.variants.off',
      'environments.production',
    ]);
  });
});
