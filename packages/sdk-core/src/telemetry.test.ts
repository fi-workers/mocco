import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvaluationCounter } from './telemetry';

import type { EvaluationCount } from './telemetry';

describe('EvaluationCounter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts per flag and variant, and sends once per window', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T10:15:00Z') });
    const sent: EvaluationCount[][] = [];
    const counter = new EvaluationCounter({
      send: async evaluations => {
        sent.push(evaluations);
        await Promise.resolve();
      },
    });
    counter.start();
    counter.record('new-checkout', 'on');
    counter.record('new-checkout', 'on');
    counter.record('new-checkout', null);
    vi.setSystemTime(new Date('2026-10-02T10:15:30Z'));
    counter.record('copy', 'short');

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([
      [
        { flag: 'new-checkout', variant: 'on', count: 2, windowStart: '2026-10-02T10:15:00.000Z' },
        { flag: 'new-checkout', variant: null, count: 1, windowStart: '2026-10-02T10:15:00.000Z' },
        { flag: 'copy', variant: 'short', count: 1, windowStart: '2026-10-02T10:15:00.000Z' },
      ],
    ]);
    await counter.stop();
  });

  it('drops a report that fails, and sends what is left on stop', async () => {
    const send = vi.fn(async () => {
      await Promise.reject(new Error('offline'));
    });
    const counter = new EvaluationCounter({ send });
    counter.record('a', 'on');
    await counter.flush();
    counter.record('b', 'on');
    await counter.stop();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual([[expect.objectContaining({ flag: 'b', count: 1 })]]);
  });
});
