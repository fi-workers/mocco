// Stale-flag hints (#144): badges on the flags table, and on a flag's page its usage from
// SDK telemetry with each finding and a way to dismiss it for a while. Advisory only.
import { STALE_AFTER_DAYS, StaleKinds } from '@mocco/common/flags';
import { useState } from 'react';

import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { StaleFindingDto, StaleKind } from '@mocco/common/flags';

interface Scope {
  workspaceId: string;
  projectId: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const staleLabels: Record<StaleKind, string> = {
  [StaleKinds.unused]: 'Not evaluated lately',
  [StaleKinds.neverEvaluated]: 'Never evaluated',
  [StaleKinds.fullyRolledOut]: 'Fully rolled out',
};

function explanation(finding: StaleFindingDto): string {
  switch (finding.kind) {
    case StaleKinds.unused: {
      return `No SDK has evaluated this flag for ${STALE_AFTER_DAYS} days. If no code reads it any more, remove it.`;
    }
    case StaleKinds.neverEvaluated: {
      return 'No SDK has ever reported evaluating this flag. Check that your code reads it, or remove it.';
    }
    default: {
      return `Every environment has served “${finding.servedVariant ?? '?'}” to everyone for ${STALE_AFTER_DAYS} days. Make that the code’s behavior and remove the flag from your code.`;
    }
  }
}

/** One badge per active finding of a flag. */
export function StaleBadges({ findings }: { findings: readonly StaleFindingDto[] }) {
  return findings.map(finding => (
    <StatusBadge key={finding.id} tone={Tones.warn}>
      {staleLabels[finding.kind]}
    </StatusBadge>
  ));
}

const DISMISS_OPTIONS = [
  { label: 'for 30 days', days: 30 },
  { label: 'for 90 days', days: 90 },
  { label: 'for a year', days: 365 },
] as const;

function Finding({ scope, finding }: { scope: Scope; finding: StaleFindingDto }) {
  const utils = trpc.useUtils();
  const [days, setDays] = useState<number>(DISMISS_OPTIONS[0].days);
  const dismissal = trpc.flags.dismissStale.useMutation({
    onSuccess: async () => {
      await utils.flags.stale.invalidate();
    },
  });
  const isDismissed = finding.dismissedUntil !== null;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={isDismissed ? Tones.neutral : Tones.warn}>{staleLabels[finding.kind]}</StatusBadge>
        {isDismissed && finding.dismissedUntil !== null ? (
          <span className="text-xs text-muted-foreground">
            Dismissed until {finding.dismissedUntil.toLocaleDateString()}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{explanation(finding)}</p>
      {isDismissed ? (
        <Button
          variant="ghost"
          className="w-fit text-sm"
          pending={dismissal.isPending}
          onClick={() => {
            dismissal.mutate({ ...scope, findingId: finding.id, until: null });
          }}>
          Show again
        </Button>
      ) : (
        <form
          aria-label={`Dismiss ${staleLabels[finding.kind]}`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            dismissal.mutate({ ...scope, findingId: finding.id, until: new Date(Date.now() + days * DAY_MS) });
          }}>
          <label className={labelClass}>
            Dismiss
            <select
              value={days}
              onChange={event => {
                setDays(Number(event.target.value));
              }}
              className={inputClass}>
              {DISMISS_OPTIONS.map(option => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" pending={dismissal.isPending} className="text-sm">
            Dismiss
          </Button>
        </form>
      )}
      {dismissal.error ? <p className="text-xs text-destructive">{errorMessage(dismissal.error)}</p> : null}
    </li>
  );
}

/** A flag's usage over the last 7 days and its stale findings, dismissed ones included. */
export function FlagUsage({ scope, flagKey }: { scope: Scope; flagKey: string }) {
  const usageQuery = trpc.flags.usage.useQuery({ ...scope, days: 7 });
  const staleQuery = trpc.flags.stale.useQuery({ ...scope, includeDismissed: true });
  const usage = usageQuery.data?.usage.find(entry => entry.flagKey === flagKey);
  const findings = (staleQuery.data?.findings ?? []).filter(finding => finding.flagKey === flagKey);
  const error = usageQuery.error ?? staleQuery.error;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Usage</h3>
      <p className="text-sm text-muted-foreground">
        {usage === undefined ? (
          'No evaluations reported in the last 7 days.'
        ) : (
          <>
            {usage.evaluations.toLocaleString()} evaluations in the last 7 days
            {usage.lastSeenAt === null ? null : (
              <>
                {' '}
                · last <Ago date={usage.lastSeenAt} />
              </>
            )}
          </>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        From the counts Mocco’s SDKs send. They only point out flags that may be ready to remove; no change depends on
        them.
      </p>
      {error ? <p className="text-xs text-destructive">{errorMessage(error)}</p> : null}
      {findings.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {findings.map(finding => (
            <Finding key={finding.id} scope={scope} finding={finding} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Above the flags table: how many flags look ready for cleanup. */
export function StaleSummary({ findings }: { findings: readonly StaleFindingDto[] }) {
  const count = new Set(findings.map(finding => finding.flagKey)).size;
  if (count === 0) {
    return null;
  }
  return (
    <Notice tone={Tones.warn} title={`${count} flag${count === 1 ? '' : 's'} may be ready for cleanup`}>
      They haven’t been evaluated lately, or serve one value to everyone everywhere. Open a flag to see why, or dismiss
      the hint for a while.
    </Notice>
  );
}
