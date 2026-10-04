// The server side of the probe protocol (#150, ADR 0027). A `@mocco/probe` agent authenticates
// with its location's token, leases the rounds due at that location, reports one result per
// lease, and heartbeats. The server decides what is checked and what a result may claim: a
// result counts only if it matches an outstanding lease of the reporting location, so a stolen
// token can't speak for another location or another monitor.
import { ProbeProtocol } from '@mocco/common/status';

import { errorSummary } from '@backend/domain/errors';
import { hashLocationToken } from '@backend/domain/status/location-token';
import { CheckResultRepo } from '@backend/domain/status/repos/check-result.repo';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { ProbeLeaseRepo } from '@backend/domain/status/repos/probe-lease.repo';

import type { LocationRow } from '@backend/domain/status/repos/location.repo';
import type { DueRound, ProbeLeaseRow } from '@backend/domain/status/repos/probe-lease.repo';
import type { VerdictEvaluator } from '@backend/domain/status/VerdictEvaluator';
import type { Db } from '@backend/infra/db/types';
import type { LocationKind, MonitorSpec, ProbeResult } from '@mocco/common/status';

export interface ProbeDeps {
  db: Db;
  /** Closes the rounds a report completes right away, instead of at the next minute's job. */
  verdicts?: Pick<VerdictEvaluator, 'evaluate'>;
  now?: () => Date;
}

/** The location a token authenticates, as the protocol routes may see it. */
export interface ProbeLocation {
  id: string;
  workspaceId: string | null;
  kind: LocationKind;
  code: string;
}

export interface ProbeLease {
  leaseId: string;
  monitorId: string;
  roundAt: Date;
  expiresAt: Date;
  spec: MonitorSpec;
}

const locationOf = (row: LocationRow): ProbeLocation => ({
  id: row.id,
  workspaceId: row.workspaceId,
  kind: row.kind,
  code: row.code,
});

/** When a round's results stop being accepted: its time, the check's timeout, and the grace. */
export const leaseExpiry = (round: Pick<DueRound, 'roundAt' | 'spec'>): Date =>
  new Date(round.roundAt.getTime() + round.spec.timeoutMs + ProbeProtocol.resultGraceSeconds * 1000);

/** Whether a reported result is the one its lease asked for. */
const isLeasedRound = (lease: ProbeLeaseRow, result: ProbeResult): boolean =>
  lease.monitorId === result.monitorId && lease.roundAt.getTime() === result.roundAt.getTime();

const ResultVerdicts = { fresh: 'fresh', duplicate: 'duplicate', rejected: 'rejected' } as const;
type ResultVerdict = (typeof ResultVerdicts)[keyof typeof ResultVerdicts];

/** A result is fresh only for an unreported, unexpired lease of this location for exactly this
 * monitor and round, between the round's time and the lease's expiry; a repeat of a reported lease
 * is a duplicate; anything else is refused. */
function verdictOf(lease: ProbeLeaseRow | undefined, result: ProbeResult, isRepeat: boolean, now: Date): ResultVerdict {
  if (lease === undefined || !isLeasedRound(lease, result)) {
    return ResultVerdicts.rejected;
  }
  if (lease.reportedAt !== null || isRepeat) {
    return ResultVerdicts.duplicate;
  }
  // A check runs at its round's time: a result before it, or after the lease expired, is refused.
  return now < lease.roundAt || now > lease.expiresAt ? ResultVerdicts.rejected : ResultVerdicts.fresh;
}

export class ProbeService {
  constructor(private readonly deps: ProbeDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The enabled location the token belongs to, or undefined. */
  async authenticate(token: string): Promise<ProbeLocation | undefined> {
    const row = await new LocationRepo(this.deps.db).findEnabledByTokenHash(hashLocationToken(token));
    return row === undefined ? undefined : locationOf(row);
  }

  /** Lease up to `capacity` rounds due at the location within the lookahead. */
  async lease(
    location: ProbeLocation,
    input: { agentVersion: string; capacity: number },
  ): Promise<{ leases: ProbeLease[]; pollAfterMs: number }> {
    const now = this.now();
    await new LocationRepo(this.deps.db).recordSeen(location.id, { lastSeenAt: now, agentVersion: input.agentVersion });
    const leased = await new ProbeLeaseRepo(this.deps.db).leaseDue({
      locationId: location.id,
      workspaceId: location.workspaceId,
      horizon: new Date(now.getTime() + ProbeProtocol.leaseLookaheadSeconds * 1000),
      limit: input.capacity,
      leasedAt: now,
      expiresAt: leaseExpiry,
    });
    return {
      leases: leased.map(lease => ({
        leaseId: lease.id,
        monitorId: lease.monitorId,
        roundAt: lease.roundAt,
        expiresAt: lease.expiresAt,
        spec: lease.spec,
      })),
      // A full batch means more is due: come back at once.
      pollAfterMs: leased.length >= input.capacity ? 0 : ProbeProtocol.pollAfterMs,
    };
  }

  /**
   * Store the results that match an outstanding lease of this location. A result whose lease
   * is another location's, names another monitor or round, or came after the lease expired is
   * refused; one already stored is a duplicate (a retried batch), never an error.
   */
  async report(
    location: ProbeLocation,
    results: readonly ProbeResult[],
  ): Promise<{ accepted: number; duplicates: number; rejected: string[] }> {
    const now = this.now();
    const found = await new ProbeLeaseRepo(this.deps.db).findForLocation(
      location.id,
      results.map(result => result.leaseId),
    );
    const leases = new Map(found.map(lease => [lease.id, lease]));
    const classified = results.map((result, index) => {
      const lease = leases.get(result.leaseId);
      const isRepeat = results.findIndex(other => other.leaseId === result.leaseId) !== index;
      return { result, lease, verdict: verdictOf(lease, result, isRepeat, now) };
    });
    const rejected = classified.flatMap(entry =>
      entry.verdict === ResultVerdicts.rejected ? [entry.result.leaseId] : [],
    );
    const duplicates = classified.filter(entry => entry.verdict === ResultVerdicts.duplicate).length;
    const fresh = classified.flatMap(({ result, lease, verdict }) =>
      verdict === ResultVerdicts.fresh && lease !== undefined ? [{ result, lease }] : [],
    );

    const inserted = await new CheckResultRepo(this.deps.db).insertNew(
      fresh.map(({ lease, result }) => ({
        monitorId: lease.monitorId,
        roundAt: lease.roundAt,
        locationId: location.id,
        workspaceId: lease.workspaceId,
        leaseId: lease.id,
        outcome: result.outcome,
        errorKind: result.errorKind,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        timings: result.timings,
        tlsExpiresAt: result.tlsExpiresAt,
        detail: result.detail?.slice(0, ProbeProtocol.detailMax),
        receivedAt: now,
      })),
    );
    // Stored now or by an earlier attempt that didn't get to mark its leases: both are reported.
    await new ProbeLeaseRepo(this.deps.db).markReported(
      location.id,
      fresh.map(({ lease }) => lease.id),
      now,
    );
    if (inserted.length > 0 && this.deps.verdicts !== undefined) {
      // Only rounds every location has now reported close here; the job closes the rest. A
      // failure here must not fail the report: the results are stored and the job retries.
      try {
        await this.deps.verdicts.evaluate({ now, monitorIds: [...new Set(fresh.map(({ lease }) => lease.monitorId))] });
      } catch (error) {
        console.error('[status] inline round evaluation failed', errorSummary(error));
      }
    }
    return { accepted: inserted.length, duplicates: duplicates + fresh.length - inserted.length, rejected };
  }

  /** The agent is alive: record when, and which version it runs. */
  async heartbeat(location: ProbeLocation, input: { agentVersion: string }): Promise<void> {
    await new LocationRepo(this.deps.db).recordSeen(location.id, {
      lastSeenAt: this.now(),
      agentVersion: input.agentVersion,
    });
  }
}
