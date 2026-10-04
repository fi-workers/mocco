// The agent loop (ADR 0027): lease the rounds due at this location, run each at its round time
// plus a little jitter, report the results in batches, and heartbeat. It keeps nothing on disk:
// a result that can't be delivered before its lease expires is dropped, and Mocco counts that
// round as `no_data` for this location, which never takes a monitor down.
import { ProbeProtocol, type ProbeLeaseDto, type ProbeResult } from '@mocco/common/status';

import { ProbeAuthError } from './errors';

import type { ProbeApi } from './client';
import type { RunCheck } from './run-check';

export interface Logger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
}

export interface AgentTiming {
  /** A check starts up to this long after its round time, so a location's checks don't all fire at once. */
  maxJitterMs: number;
  /** Results wait this long for company before they are posted (a full batch goes at once). */
  flushDelayMs: number;
  heartbeatIntervalMs: number;
  /** The first retry delay after a failed call; it doubles up to `backoffMaxMs`. */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_AGENT_TIMING: AgentTiming = {
  maxJitterMs: 2000,
  flushDelayMs: 1000,
  heartbeatIntervalMs: 30_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
};

export interface ProbeAgentOptions {
  api: ProbeApi;
  runCheck: RunCheck;
  /** How many checks run at once; also the most rounds leased per call. */
  concurrency: number;
  log: Logger;
  timing?: Partial<AgentTiming>;
  random?: () => number;
}

interface Pending {
  result: ProbeResult;
  expiresAt: Date;
}

/** Waits `ms`, or less if the signal aborts first. */
const pause = async (ms: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ProbeAgent {
  private readonly timing: AgentTiming;

  private readonly random: () => number;

  /** Checks waiting for their round time. */
  private readonly scheduled = new Set<NodeJS.Timeout>();

  /** Checks running or waiting for a slot. */
  private readonly runs = new Set<Promise<void>>();

  private readonly slotWaiters: (() => void)[] = [];

  private running = 0;

  private outbox: Pending[] = [];

  private flushTimer: NodeJS.Timeout | undefined;

  private flushing: Promise<void> | undefined;

  private reportFailures = 0;

  constructor(private readonly options: ProbeAgentOptions) {
    this.timing = { ...DEFAULT_AGENT_TIMING, ...options.timing };
    this.random = options.random ?? Math.random;
  }

  private schedule(lease: ProbeLeaseDto): void {
    const delay = Math.max(0, lease.roundAt.getTime() - Date.now()) + this.random() * this.timing.maxJitterMs;
    const timer = setTimeout(() => {
      this.scheduled.delete(timer);
      const run = this.execute(lease);
      this.runs.add(run);
      // eslint-disable-next-line no-void -- bookkeeping only; execute() never rejects
      void this.forgetWhenSettled(run);
    }, delay);
    this.scheduled.add(timer);
  }

  /** Runs one leased check and queues its result; never rejects. */
  private async execute(lease: ProbeLeaseDto): Promise<void> {
    await this.acquireSlot();
    try {
      const report = await this.options.runCheck(lease.spec);
      this.enqueue({
        result: { ...report, leaseId: lease.leaseId, monitorId: lease.monitorId, roundAt: lease.roundAt },
        expiresAt: lease.expiresAt,
      });
    } catch (error) {
      this.options.log.warn('Check crashed', { monitorId: lease.monitorId, error: messageOf(error) });
    } finally {
      this.releaseSlot();
    }
  }

  /** Drops a run from the set once it settles; `drain` waits on what is still there. */
  private async forgetWhenSettled(run: Promise<void>): Promise<void> {
    await run;
    this.runs.delete(run);
  }

  private async acquireSlot(): Promise<void> {
    if (this.running < this.options.concurrency) {
      this.running += 1;
      return;
    }
    await new Promise<void>(resolve => {
      this.slotWaiters.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next === undefined) {
      this.running -= 1;
    } else {
      // The slot passes straight to the next waiter.
      next();
    }
  }

  private enqueue(pending: Pending): void {
    this.outbox.push(pending);
    if (this.outbox.length >= ProbeProtocol.maxResults) {
      this.scheduleFlush(0);
    } else if (this.flushTimer === undefined) {
      this.scheduleFlush(this.timing.flushDelayMs);
    }
  }

  private scheduleFlush(delayMs: number): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      // eslint-disable-next-line no-void -- a timer callback can't await; flush() never rejects
      void this.flush();
    }, delayMs);
  }

  /** Posts the outbox in batches, one flush at a time; never rejects. */
  private async flush(): Promise<void> {
    if (this.flushing !== undefined) {
      await this.flushing;
    }
    this.flushing = this.flushBatches();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  private async flushBatches(): Promise<void> {
    const now = Date.now();
    const live = this.outbox.filter(pending => pending.expiresAt.getTime() > now);
    if (live.length < this.outbox.length) {
      this.options.log.warn('Dropped results whose leases expired before they could be posted', {
        expired: this.outbox.length - live.length,
      });
    }
    this.outbox = live;
    while (this.outbox.length > 0) {
      const batch = this.outbox.slice(0, ProbeProtocol.maxResults);
      try {
        // eslint-disable-next-line no-await-in-loop -- batches go one after another
        const answer = await this.options.api.report(batch.map(pending => pending.result));
        this.reportFailures = 0;
        this.outbox = this.outbox.slice(batch.length);
        if (answer.rejected.length > 0) {
          this.options.log.warn('Mocco rejected results (late, or for a lease this location does not hold)', {
            rejected: answer.rejected.length,
          });
        }
      } catch (error) {
        // Keep them for the next try; they are dropped there if their leases expired meanwhile.
        this.reportFailures += 1;
        const retryInMs = this.backoff(this.reportFailures);
        this.options.log.warn('Posting results failed; retrying', { error: messageOf(error), retryInMs });
        if (this.flushTimer === undefined) {
          this.scheduleFlush(retryInMs);
        }
        return;
      }
    }
  }

  private async beat(): Promise<void> {
    try {
      await this.options.api.heartbeat(this.inflight);
    } catch (error) {
      this.options.log.warn('Heartbeat failed', { error: messageOf(error) });
    }
  }

  private startHeartbeat(): () => void {
    const timer = setInterval(() => {
      // eslint-disable-next-line no-void -- a timer callback can't await; beat() never rejects
      void this.beat();
    }, this.timing.heartbeatIntervalMs);
    return () => {
      clearInterval(timer);
    };
  }

  /** On shutdown: cancel what hasn't started, finish what has, post what is left once. */
  private async drain(): Promise<void> {
    this.scheduled.forEach(timer => {
      clearTimeout(timer);
    });
    this.scheduled.clear();
    await Promise.allSettled(this.runs);
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.flush();
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  /** Exponential backoff with jitter: base, 2×base, 4×base … up to the cap, each ×0.5–1. */
  private backoff(failures: number): number {
    const ceiling = Math.min(this.timing.backoffMaxMs, this.timing.backoffBaseMs * 2 ** (failures - 1));
    return Math.round(ceiling * (0.5 + this.random() / 2));
  }

  /** Checks leased and not yet reported back (scheduled or running). */
  get inflight(): number {
    return this.scheduled.size + this.runs.size;
  }

  /**
   * Runs until `signal` aborts, then stops leasing, drops the checks that haven't started
   * (their rounds become `no_data`), waits for the running ones and posts what it has.
   * Rejects with `ProbeAuthError` when Mocco refuses the token.
   */
  async run(signal: AbortSignal): Promise<void> {
    const stopHeartbeat = this.startHeartbeat();
    let failures = 0;
    try {
      while (!signal.aborted) {
        let waitMs: number;
        try {
          // eslint-disable-next-line no-await-in-loop -- one lease call at a time
          const batch = await this.options.api.lease(Math.min(ProbeProtocol.maxCapacity, this.options.concurrency));
          failures = 0;
          if (batch.skipped > 0) {
            this.options.log.warn('Skipped leases of a monitor kind this agent does not know; update @mocco/probe', {
              skipped: batch.skipped,
            });
          }
          // eslint-disable-next-line no-restricted-syntax -- scheduling is a side effect per lease
          for (const lease of batch.leases) {
            this.schedule(lease);
          }
          waitMs = batch.pollAfterMs;
        } catch (error) {
          if (error instanceof ProbeAuthError) {
            throw error;
          }
          failures += 1;
          waitMs = this.backoff(failures);
          this.options.log.warn('Lease failed; retrying', { error: messageOf(error), retryInMs: waitMs });
        }
        // eslint-disable-next-line no-await-in-loop -- the loop waits between lease calls
        await pause(waitMs, signal);
      }
    } finally {
      stopHeartbeat();
      await this.drain();
    }
  }
}
