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

describe('moccoConfigSchema — v2 credential lint', () => {
  const gate = { kind: 'gate', name: 'prod-approval', resume: [{ role: 'deployer', count: 1 }] };
  const credential = { provider: 'aws', role: 'deploy-role', ttl: 900, gate: 'prod-approval' };
  const credentialedStep = { kind: 'step', run: 'deploy', executor: 'generic', credential };

  it('accepts a credentialed step whose gate appears earlier in the pipeline', () => {
    const cfg = { version: 2, pipeline: 'deploy', steps: [gate, credentialedStep] };
    expect(moccoConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it('rejects a credentialed step naming a gate that does not exist', () => {
    const cfg = {
      version: 2,
      pipeline: 'deploy',
      steps: [gate, { ...credentialedStep, credential: { ...credential, gate: 'nonexistent' } }],
    };
    expect(moccoConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('rejects a credentialed step whose named gate appears only LATER (not dominating)', () => {
    const cfg = { version: 2, pipeline: 'deploy', steps: [credentialedStep, gate] };
    expect(moccoConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('accepts a v2 step with no credential (the field is optional)', () => {
    const cfg = {
      version: 2,
      pipeline: 'deploy',
      steps: [gate, { kind: 'step', run: 'deploy', executor: 'generic' }],
    };
    expect(moccoConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it('rejects a credential with a non-positive ttl', () => {
    const cfg = {
      version: 2,
      pipeline: 'deploy',
      steps: [gate, { ...credentialedStep, credential: { ...credential, ttl: 0 } }],
    };
    expect(moccoConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('rejects unknown keys inside credential (strict)', () => {
    const cfg = {
      version: 2,
      pipeline: 'deploy',
      steps: [gate, { ...credentialedStep, credential: { ...credential, bogus: 1 } }],
    };
    expect(moccoConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('leaves v1 configs unaffected (no credential field, no lint)', () => {
    expect(moccoConfigSchema.safeParse(valid).success).toBe(true);
  });
});
