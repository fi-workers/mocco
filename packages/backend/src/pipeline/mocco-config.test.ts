import { moccoConfigSchema } from '@mocco/common/mocco-config';
import { describe, it, expect } from 'vitest';

const valid = {
  version: 1,
  pipeline: 'deploy',
  steps: [{ run: 'build', executor: 'generic', with: { cmd: 'echo hi' } }],
};

describe('moccoConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    expect(moccoConfigSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects version !== 1', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });
  it('rejects empty steps', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, steps: [] }).success).toBe(false);
  });
  it('rejects a step missing executor', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, steps: [{ run: 'x' }] }).success).toBe(false);
  });
  it('rejects unknown top-level keys (strict)', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, nope: 1 }).success).toBe(false);
  });
  it('rejects unknown step keys (strict)', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, steps: [{ run: 'x', executor: 'g', bogus: 1 }] }).success).toBe(
      false,
    );
  });
  it('allows arbitrary keys inside with', () => {
    expect(
      moccoConfigSchema.safeParse({ ...valid, steps: [{ run: 'x', executor: 'g', with: { anything: [1, 2] } }] })
        .success,
    ).toBe(true);
  });
  it('rejects duplicate step names', () => {
    const dup = {
      ...valid,
      steps: [
        { run: 'a', executor: 'g' },
        { run: 'a', executor: 'g' },
      ],
    };
    expect(moccoConfigSchema.safeParse(dup).success).toBe(false);
  });
});
