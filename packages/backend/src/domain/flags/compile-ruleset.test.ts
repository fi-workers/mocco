import { describe, expect, it } from 'vitest';

import { compileRuleset, rulesetEtag } from '@backend/domain/flags/compile-ruleset';
import { flagdValidator } from '@backend/domain/flags/testing/flagd-schema';

import type { CompiledFlagInput } from '@backend/domain/flags/compile-ruleset';

const flag = (key: string, config: Partial<CompiledFlagInput['config']> = {}): CompiledFlagInput => ({
  key,
  variants: { on: true, off: false },
  lifecycle: 'temporary',
  config: { enabled: false, killed: false, defaultVariant: 'on', offVariant: 'off', ...config },
});
const at = new Date('2026-10-02T00:00:00.000Z');

describe('compileRuleset', () => {
  it('emits a document valid against the flagd v0 schema', async () => {
    const validate = await flagdValidator();
    const document = compileRuleset(
      { key: 'production', version: 3 },
      [flag('new-checkout', { enabled: true }), flag('dark-mode'), flag('beta', { killed: true })],
      at,
    );

    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(compileRuleset({ key: 'empty', version: 0 }, [], at))).toBe(true);
  });

  it('serves the code default when disabled and the off variant when killed', () => {
    const { flags, metadata } = compileRuleset(
      { key: 'production', version: 3 },
      [
        flag('enabled', { enabled: true }),
        flag('disabled'),
        flag('killed', { enabled: true, killed: true }),
        flag('killed-while-disabled', { killed: true }),
      ],
      at,
    );

    expect(metadata).toEqual({
      'mocco.environment': 'production',
      'mocco.version': 3,
      'mocco.generatedAt': '2026-10-02T00:00:00.000Z',
      'mocco.bucketing': 'mocco-v1',
    });
    expect(flags.enabled).toMatchObject({ state: 'ENABLED', defaultVariant: 'on', targeting: {} });
    expect(flags.disabled).toMatchObject({ state: 'DISABLED' });
    const killed = { state: 'ENABLED', defaultVariant: 'off', metadata: { 'mocco.killed': true } };
    expect([flags.killed, flags['killed-while-disabled']]).toMatchObject([killed, killed]);
  });

  it('gives equal documents the same ETag regardless of flag order', () => {
    const a = compileRuleset({ key: 'p', version: 1 }, [flag('a'), flag('b')], at);
    const b = compileRuleset({ key: 'p', version: 1 }, [flag('b'), flag('a')], at);
    const c = compileRuleset({ key: 'p', version: 2 }, [flag('a'), flag('b')], at);

    expect(rulesetEtag(a)).toBe(rulesetEtag(b));
    expect(rulesetEtag(a)).not.toBe(rulesetEtag(c));
    expect(rulesetEtag(a)).toMatch(/^"[\w-]+"$/u);
  });
});
