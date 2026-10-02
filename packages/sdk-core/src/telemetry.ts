// Evaluation telemetry for the flag providers: count evaluations per flag and variant in
// memory and send the counts at most once a window (`POST /v1/flags/telemetry`). Mocco
// uses them only to point out flags nobody evaluates any more; a failed send is dropped,
// never retried, so telemetry can't pile up or slow evaluations.

/** One `POST /v1/flags/telemetry` entry. */
export interface EvaluationCount {
  flag: string;
  variant: string | null;
  count: number;
  windowStart: string;
}

export interface EvaluationCounterOptions {
  /** Sends one report; a rejection drops it. */
  send: (evaluations: EvaluationCount[]) => Promise<void>;
  /** How often to send (default 60 s, at least 10 s). */
  flushIntervalMs?: number;
  /** Don't keep the process alive for the timer (Node). */
  unrefTimer?: boolean;
  now?: () => number;
}

export const TELEMETRY_PATH = '/flags/telemetry';
export const DEFAULT_TELEMETRY_INTERVAL_MS = 60_000;
const MIN_TELEMETRY_INTERVAL_MS = 10_000;
/** Mocco accepts this many entries per report; more flags in a window send early. */
const MAX_ENTRIES = 500;

export class EvaluationCounter {
  private counts: Record<string, EvaluationCount> = {};

  private size = 0;

  private windowStart: number | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly now: () => number;

  constructor(private readonly options: EvaluationCounterOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Count one evaluation. Cheap: no I/O. */
  record(flag: string, variant: string | null): void {
    this.windowStart ??= this.now();
    const id = `${flag}\n${variant ?? ''}`;
    const current = this.counts[id];
    if (current === undefined) {
      this.counts[id] = { flag, variant, count: 1, windowStart: new Date(this.windowStart).toISOString() };
      this.size += 1;
      if (this.size >= MAX_ENTRIES) {
        // eslint-disable-next-line no-void -- fire and forget; flush() never rejects
        void this.flush();
      }
    } else {
      current.count += 1;
    }
  }

  /** Send what was counted since the last send, if anything. Never rejects. */
  async flush(): Promise<void> {
    if (this.size === 0) {
      return;
    }
    const evaluations = Object.values(this.counts);
    this.counts = {};
    this.size = 0;
    this.windowStart = undefined;
    try {
      await this.options.send(evaluations);
    } catch {
      // Advisory data: drop it.
    }
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    const interval = Math.max(MIN_TELEMETRY_INTERVAL_MS, this.options.flushIntervalMs ?? DEFAULT_TELEMETRY_INTERVAL_MS);
    this.timer = setInterval(() => {
      // eslint-disable-next-line no-void -- a timer callback can't await; flush() never rejects
      void this.flush();
    }, interval);
    if (this.options.unrefTimer === true && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /** Stop the timer and send what's left. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
