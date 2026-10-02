// Which flags look ready for cleanup (#144). Pure: the detector loads the inputs.
import { FlagLifecycles, StaleKinds } from '@mocco/common/flags';

import type { DesiredFinding } from '@backend/domain/flags/repos/flag-stale-finding.repo';
import type { FlagLifecycle, RolloutEntry, Rule } from '@mocco/common/flags';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleFlag {
  id: string;
  key: string;
  lifecycle: FlagLifecycle;
  createdAt: Date;
}

export interface StaleConfig {
  flagId: string;
  environmentId: string;
  enabled: boolean;
  killed: boolean;
  defaultVariant: string;
  rules: readonly Rule[];
  rollout: readonly RolloutEntry[] | null;
  /** When the config last changed; null when that snapshot is gone (so: long ago). */
  changedAt: Date | null;
}

export interface StaleInputs {
  flags: readonly StaleFlag[];
  configs: readonly StaleConfig[];
  environmentIds: readonly string[];
  /** When each flag key was last evaluated in any environment. */
  lastSeen: ReadonlyMap<string, Date>;
}

/** The one variant a config serves to every caller, or null when it can differ by
 * caller (rules, a split rollout) or the caller's code decides (disabled, killed). */
function servedToEveryone(config: StaleConfig): string | null {
  if (!config.enabled || config.killed || config.rules.length > 0) {
    return null;
  }
  if (config.rollout === null) {
    return config.defaultVariant;
  }
  const served = new Set(config.rollout.filter(entry => entry.weight > 0).map(entry => entry.variant));
  return served.size === 1 ? ([...served][0] ?? null) : null;
}

/** The variant every environment has served to everyone since before `cutoff`, if any. */
function fullyRolledOutVariant(configs: readonly StaleConfig[], environmentIds: readonly string[], cutoff: Date) {
  if (environmentIds.length === 0 || configs.length !== environmentIds.length) {
    return null;
  }
  const isSettled = configs.every(config => config.changedAt === null || config.changedAt <= cutoff);
  const served = new Set(configs.map(config => servedToEveryone(config)));
  const [variant] = served;
  return isSettled && served.size === 1 && variant !== undefined && variant !== null ? variant : null;
}

/**
 * The findings for every temporary flag older than `staleDays`: never evaluated; not
 * evaluated in `staleDays`; or one variant to everyone in every environment, unchanged
 * for `staleDays`. Permanent flags are exempt.
 */
export function detectStale(inputs: StaleInputs, now: Date, staleDays: number): DesiredFinding[] {
  const cutoff = new Date(now.getTime() - staleDays * DAY_MS);
  return inputs.flags
    .filter(flag => flag.lifecycle === FlagLifecycles.temporary && flag.createdAt <= cutoff)
    .flatMap(flag => {
      const lastSeen = inputs.lastSeen.get(flag.key) ?? null;
      const findings: DesiredFinding[] = [];
      if (lastSeen === null) {
        findings.push({ flagId: flag.id, kind: StaleKinds.neverEvaluated, lastEvaluatedAt: null, servedVariant: null });
      } else if (lastSeen <= cutoff) {
        findings.push({ flagId: flag.id, kind: StaleKinds.unused, lastEvaluatedAt: lastSeen, servedVariant: null });
      }
      const configs = inputs.configs.filter(config => config.flagId === flag.id);
      const variant = fullyRolledOutVariant(configs, inputs.environmentIds, cutoff);
      if (variant !== null) {
        findings.push({
          flagId: flag.id,
          kind: StaleKinds.fullyRolledOut,
          lastEvaluatedAt: lastSeen,
          servedVariant: variant,
        });
      }
      return findings;
    });
}
