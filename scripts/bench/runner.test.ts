import { describe, expect, test } from 'bun:test';
import type { BenchCase } from './runner.ts';
import { median, percentile, runCase, summarise } from './runner.ts';

/**
 * The harness is the thing every baseline is read through, so a bug here is
 * silent: it does not fail a run, it publishes a wrong number that somebody
 * later sets a budget against.
 */
describe('statistics', () => {
  test('median of an odd sample is the middle element', () => {
    expect(median([1, 2, 3])).toBe(2);
  });

  test('median of an even sample averages the middle pair', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test('percentile picks by nearest rank and never runs off the end', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
    // Rank 0 would index -1 and return undefined, which formats as NaN ms
    // rather than failing - so the floor is clamped rather than trusted.
    expect(percentile(sorted, 0)).toBe(1);
  });

  test('empty samples throw rather than reporting a number', () => {
    expect(() => median([])).toThrow();
    expect(() => percentile([], 50)).toThrow();
    expect(() => summarise([])).toThrow();
  });

  test('summarise reports the spread of an unsorted sample', () => {
    const stats = summarise([5, 1, 3, 2, 4]);
    expect(stats.samples).toBe(5);
    expect(stats.minMs).toBe(1);
    expect(stats.maxMs).toBe(5);
    expect(stats.medianMs).toBe(3);
    expect(stats.meanMs).toBe(3);
    // p95 of five samples is the largest; (5 - 1) / 3.
    expect(stats.spread).toBeCloseTo(4 / 3, 10);
  });

  test('a perfectly flat sample has no spread', () => {
    const stats = summarise([2, 2, 2, 2]);
    expect(stats.stddevMs).toBe(0);
    expect(stats.spread).toBe(0);
  });

  test('a sub-resolution case reports no spread rather than dividing by zero', () => {
    const stats = summarise([0, 0, 0]);
    expect(stats.spread).toBe(0);
    expect(Number.isNaN(stats.spread)).toBe(false);
  });
});

describe('runCase', () => {
  test('repeats divide the sample so the median is a per-operation cost', async () => {
    let calls = 0;
    const result = await runCase({
      name: 'batched',
      surface: 'shaping',
      what: 'ten calls per sample',
      iterations: 4,
      warmup: 1,
      repeats: 10,
      run: () => {
        calls++;
      },
    });
    // Warmup is one call, not one batch; the timed samples are four batches of ten.
    expect(calls).toBe(41);
    expect(result.samples).toBe(4);
    expect(result.repeats).toBe(10);
  });

  test('a case without repeats reports one call per sample', async () => {
    const result = await runCase({
      name: 'plain',
      surface: 'shaping',
      what: 'one call per sample',
      iterations: 2,
      warmup: 0,
      run: () => {},
    });
    expect(result.repeats).toBe(1);
  });

  test('times the requested iterations and excludes warmup from the sample', async () => {
    let calls = 0;
    const bench: BenchCase = {
      name: 'counter',
      surface: 'shaping',
      what: 'counts its own calls',
      iterations: 5,
      warmup: 2,
      run: () => {
        calls++;
      },
    };
    const result = await runCase(bench);
    expect(calls).toBe(7);
    expect(result.samples).toBe(5);
    expect(result.name).toBe('counter');
    expect(result.surface).toBe('shaping');
  });

  test('awaits an async body rather than timing how long it took to return a promise', async () => {
    const result = await runCase({
      name: 'sleeper',
      surface: 'session',
      what: 'sleeps 10ms',
      iterations: 3,
      warmup: 0,
      run: () => Bun.sleep(10),
    });
    expect(result.minMs).toBeGreaterThanOrEqual(8);
  });

  test('runs setup before the body and teardown after it', async () => {
    const order: string[] = [];
    await runCase({
      name: 'ordered',
      surface: 'session',
      what: 'records its lifecycle',
      iterations: 1,
      warmup: 0,
      setup: () => {
        order.push('setup');
      },
      run: () => {
        order.push('run');
      },
      teardown: () => {
        order.push('teardown');
      },
    });
    expect(order).toEqual(['setup', 'run', 'teardown']);
  });

  test('teardown still runs when the body throws', async () => {
    let torn = false;
    const failing = runCase({
      name: 'thrower',
      surface: 'session',
      what: 'throws',
      iterations: 1,
      warmup: 0,
      run: () => {
        throw new Error('boom');
      },
      teardown: () => {
        torn = true;
      },
    });
    await expect(failing).rejects.toThrow('boom');
    // Without this the fixture directory of a failing case survives the run and
    // the next one starts against somebody else's leftovers.
    expect(torn).toBe(true);
  });
});
