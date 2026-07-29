import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { trpc } from '@frontend/lib/trpc';

import type { AuditEntryDto } from '@mocco/common/audit';

/** Poll cadence for the chain read + verification. Audit is durable, not real-time,
 * so a relaxed interval keeps the badge fresh without hammering the chain walk. */
const POLL_MS = 5000;

interface Props {
  workspaceId: string;
}

/** The chain-intact badge: green "Verified" once the chain re-walk reconciles, red
 * "Broken at #<seq>" the moment a stored hash/linkage no longer matches its content.
 * Never blocks — while the first verify is in flight it shows a muted "Checking…". */
function ChainBadge({ workspaceId }: Props) {
  const verifyQuery = trpc.audit.verify.useQuery({ workspaceId }, { retry: false, refetchInterval: POLL_MS });

  if (verifyQuery.data === undefined) {
    return <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">Checking…</span>;
  }
  if (verifyQuery.data.intact) {
    return (
      <span className="rounded-md border border-emerald-600/40 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:border-emerald-400/40 dark:text-emerald-400">
        Chain verified
      </span>
    );
  }
  return (
    <span className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive">
      Chain broken at #{verifyQuery.data.brokenAtSeq}
    </span>
  );
}

/** The actor label — a governed action taken by a person shows their (short) id; a
 * machine/runtime request (a credential issue/deny) has no interactive actor. */
function actorLabel(entry: AuditEntryDto): string {
  return entry.actorUserId === null ? 'system' : entry.actorUserId.slice(0, 8);
}

/** The subject label — the governed entity the entry is about (its short id). */
function subjectLabel(entry: AuditEntryDto): string {
  return `${entry.subjectType} ${entry.subjectId.slice(0, 8)}`;
}

/**
 * The workspace audit surface: the append-only chain of governed decisions (gate
 * resume/reject, credential issue/deny, run trigger) with a chain-intact badge.
 *
 * UX invariant (mirrors run-detail): the spinner shows ONLY on the very first load
 * (`isPending`). Every subsequent background poll is silent — React Query keeps the
 * last data, so the table stays rendered and updates in place, never a blocking
 * spinner on refetch. A manual "Re-verify" forces an immediate re-walk.
 */
export default function WorkspaceAudit({ workspaceId }: Props) {
  const utils = trpc.useUtils();
  const listQuery = trpc.audit.list.useQuery({ workspaceId }, { retry: false, refetchInterval: POLL_MS });

  const reverify = async (): Promise<void> => {
    await Promise.all([utils.audit.verify.invalidate({ workspaceId }), utils.audit.list.invalidate({ workspaceId })]);
  };

  if (listQuery.isPending) {
    return <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />;
  }

  const entries = listQuery.isError ? [] : listQuery.data.entries;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Audit</h1>
          <ChainBadge workspaceId={workspaceId} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fireAndForget(reverify());
            }}>
            Re-verify
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Every governed decision, appended to a tamper-evident per-workspace hash chain.
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No audit entries yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  #
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Actor
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Subject
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{entry.seq}</td>
                  <td className="px-4 py-2 font-medium">{entry.action}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{actorLabel(entry)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{subjectLabel(entry)}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{entry.createdAt.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
