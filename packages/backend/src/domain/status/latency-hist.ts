// Latency histograms with fixed log buckets (#152). Every histogram has the same buckets, so the
// hours of a day add up bucket by bucket and a percentile can be read from any sum of them,
// which averaging hourly percentiles could not give. Pure.

/** Buckets per histogram (the `latency_hist` arrays' length). */
export const LATENCY_BUCKETS = 16;

/** Bucket `i` holds latencies below `8 * 2^i` ms (and at or above the previous bound); the last
 * bucket, from 131,072 ms, has no upper bound. Doubling bounds keep the error of a percentile
 * under a factor of two at any scale, from a fast cache hit to a check's 30-second timeout. */
const FIRST_BOUND_MS = 8;

export type LatencyHist = number[];

export const emptyHist = (): LatencyHist => Array.from({ length: LATENCY_BUCKETS }, () => 0);

const upperBoundOf = (bucket: number): number => FIRST_BOUND_MS * 2 ** bucket;

const lowerBoundOf = (bucket: number): number => (bucket === 0 ? 0 : upperBoundOf(bucket - 1));

/** The bucket a latency falls in. */
export function bucketOf(latencyMs: number): number {
  const bucket = latencyMs < FIRST_BOUND_MS ? 0 : Math.floor(Math.log2(latencyMs / FIRST_BOUND_MS)) + 1;
  return Math.min(Math.max(bucket, 0), LATENCY_BUCKETS - 1);
}

/** A histogram of these latencies. */
export function histOf(latenciesMs: readonly number[]): LatencyHist {
  const buckets = latenciesMs.map(latency => bucketOf(latency));
  return emptyHist().map((_, bucket) => buckets.filter(of => of === bucket).length);
}

/** The bucket-by-bucket sum. A stored array of another length (none exists) is read as empty
 * past its end. */
export function mergeHists(hists: readonly (readonly number[])[]): LatencyHist {
  return emptyHist().map((_, bucket) => hists.reduce((sum, hist) => sum + (hist[bucket] ?? 0), 0));
}

/**
 * The `p` percentile (0 to 1) of a histogram, interpolated linearly inside the bucket it falls
 * in, in whole milliseconds; null for an empty histogram. The open last bucket gives its lower
 * bound.
 */
export function percentileOf(hist: readonly number[], p: number): number | null {
  const total = hist.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return null;
  }
  const rank = Math.max(p * total, Number.MIN_VALUE);
  let seen = 0;
  for (let bucket = 0; bucket < LATENCY_BUCKETS; bucket += 1) {
    const count = hist[bucket] ?? 0;
    if (count > 0 && seen + count >= rank) {
      const lower = lowerBoundOf(bucket);
      if (bucket === LATENCY_BUCKETS - 1) {
        return lower;
      }
      return Math.round(lower + ((rank - seen) / count) * (upperBoundOf(bucket) - lower));
    }
    seen += count;
  }
  return lowerBoundOf(LATENCY_BUCKETS - 1);
}
