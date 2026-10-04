import { describe, expect, it } from 'vitest';

import { FLAGS_PLAN_CHECK_NAME, renderPlanCheck } from '@backend/domain/flags/plan-check-report';

import type { FlagsSyncPlan } from '@backend/domain/flags/flags-file';
import type { PlanCheckEnvironment, PlanCheckProject } from '@backend/domain/flags/plan-check-report';

const SHA = '3f9c2a1b4d5e6f708192a3b4c5d6e7f809112233';

const ENVIRONMENTS: PlanCheckEnvironment[] = [
  {
    key: 'production',
    name: 'Production',
    changeGate: { resume: [{ role: 'release', count: 2 }], prevent_self: true, reason_required: false },
  },
  { key: 'staging', name: 'Staging', changeGate: null },
];

const EMPTY_PLAN: FlagsSyncPlan = { creations: [], definitionUpdates: [], adopted: [], released: [], changes: [] };

const project = (name: string, result: PlanCheckProject['result']): PlanCheckProject => ({
  name,
  environments: ENVIRONMENTS,
  result,
});

const PLAN: FlagsSyncPlan = {
  creations: [
    {
      key: 'onboarding_v2',
      type: 'boolean',
      variants: { on: true, off: false },
      offVariant: 'off',
      description: null,
      lifecycle: 'temporary',
      clientVisible: true,
    },
  ],
  definitionUpdates: [{ key: 'checkout', description: 'New', addedVariants: { compact: 'c' } }],
  adopted: ['checkout'],
  released: ['legacy_banner'],
  changes: [
    {
      environmentKey: 'production',
      ops: [
        { op: 'set_default_variant', flagKey: 'onboarding_v2', variant: 'off' },
        {
          op: 'set_rules',
          flagKey: 'onboarding_v2',
          rules: [
            {
              clauses: [
                { attribute: 'plan', op: 'in', values: ['pro', 'enterprise'] },
                { segment: 'beta', negate: true },
              ],
              serve: { variant: 'on' },
            },
          ],
        },
        { op: 'set_enabled', flagKey: 'onboarding_v2', enabled: true },
        { op: 'set_enabled', flagKey: 'legacy_banner', enabled: false },
      ],
    },
    {
      environmentKey: 'staging',
      ops: [
        {
          op: 'set_rollout',
          flagKey: 'checkout',
          rollout: [
            { variant: 'on', weight: 1 },
            { variant: 'off', weight: 3 },
          ],
        },
      ],
    },
  ],
};

describe('renderPlanCheck', () => {
  it('reports a plan as success: flags, then each environment with its ops and whether it waits for approval', () => {
    const report = renderPlanCheck({ headSha: SHA, projects: [project('Acme Mobile', { plan: PLAN, issues: [] })] });

    expect(report).toMatchObject({ name: FLAGS_PLAN_CHECK_NAME, headSha: SHA, conclusion: 'success' });
    expect(report.title).toBe('5 changes in 2 environments, 1 waiting for approval');
    expect(report.summary).toContain('`.mocco/flags.yml` at `3f9c2a1`');
    expect(report.summary).toContain(
      '| Acme Mobile | 1 new flag · 5 changes in 2 environments · Production waits for approval |',
    );
    expect(report.summary).toContain('never blocks a merge');
    expect(report.text).toContain('- Creates `onboarding_v2` (boolean, variants `on`, `off`)');
    expect(report.text).toContain('- Updates `checkout`: description, adds variants `compact`');
    expect(report.text).toContain('- Takes over `checkout` from the console');
    expect(report.text).toContain('- Hands `legacy_banner` back to the console, turned off everywhere');
    expect(report.text).toContain(
      '| Production (`production`) | 4 | Waits for approval (2 × `release`, not by its proposers) |',
    );
    expect(report.text).toContain('| Staging (`staging`) | 1 | At once |');
    expect(report.text).toContain('- `onboarding_v2`: serve `off` by default; set 1 rule; turn on');
    expect(report.text).toContain('  1. when `plan` in `pro`, `enterprise` and not in segment `beta`, serve `on`');
    expect(report.text).toContain('- `legacy_banner`: turn off');
    expect(report.text).toContain('- `checkout`: roll out `on` 25% / `off` 75% by default');
  });

  it('reports a refused file as neutral with every issue, and still plans the other projects', () => {
    const report = renderPlanCheck({
      headSha: SHA,
      projects: [
        project('Acme Mobile', {
          plan: null,
          issues: [
            { path: 'flags.checkout.targets.prod', message: 'There is no environment "prod" in this project' },
            { path: '', message: 'Bad | indentation\n  here', line: 4 },
          ],
        }),
        project('Web', { plan: EMPTY_PLAN, issues: [] }),
      ],
    });

    expect(report.conclusion).toBe('neutral');
    expect(report.title).toBe('.mocco/flags.yml is refused: 2 issues');
    expect(report.summary).toContain('| Acme Mobile | Refused: 2 issues |');
    expect(report.summary).toContain('| Web | No changes |');
    expect(report.text).toContain('| `flags.checkout.targets.prod` | There is no environment "prod" in this project |');
    expect(report.text).toContain(String.raw`| the file (line 4) | Bad \| indentation here |`);
    expect(report.text).toContain('Web already matches the file.');
  });

  it('says so when the file changes nothing', () => {
    const report = renderPlanCheck({
      headSha: SHA,
      projects: [project('Acme Mobile', { plan: EMPTY_PLAN, issues: [] })],
    });

    expect(report).toMatchObject({ conclusion: 'success', title: 'No flag changes' });
  });

  it('counts definition changes when no environment changes', () => {
    const plan: FlagsSyncPlan = { ...EMPTY_PLAN, adopted: ['checkout'] };
    const report = renderPlanCheck({ headSha: SHA, projects: [project('Acme Mobile', { plan, issues: [] })] });

    expect(report).toMatchObject({ conclusion: 'success', title: '1 flag definition change' });
    expect(report.text).toContain('No environment changes.');
  });
});
