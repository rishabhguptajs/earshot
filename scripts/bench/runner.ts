/**
 * Measurement primitives for the performance harness.
 *
 * This slice records baselines; it deliberately enforces nothing. A regression
 * budget set before the spread of a measurement is known fails on runner noise
 * instead of on regressions, and a perf check that cries wolf gets disabled.
 * So every result carries its spread alongside its centre, and the budgets come
 * later, from the recorded history rather than from a guess.
 */

/** The four surfaces M7 names. A case belongs to exactly one. */
export type Surface = 'startup' | 'rendering' | 'shaping' | 'session';

export interface BenchCase {
  name: string;
  surface: Surface;
  /** What one iteration measures, in the reader's terms, not the code's. */
  what: string;
  /** Run once before the timed iterations; its cost is never counted. */
  setup?: () => Promise<void> | void;
  /** Run after the timed iterations, even when one of them threw. */
  teardown?: () => Promise<void> | void;
  run: () => Promise<unknown> | unknown;
  iterations?: number;
  /**
   * How many times `run` is called inside one timed sample; the duration is
   * divided by it to report a per-operation cost.
   *
   * A case that finishes in microseconds otherwise measures the timer rather
   * than the code: the first baselines put the sub-millisecond cases at spreads
   * of 200-370% against 8-11% for process startup, which is clock resolution,
   * not variance in the work. Batching lifts each sample clear of that floor.
   */
  repeats?: number;
  /**
   * Untimed runs before the timed ones. JIT warmup and lazy module loading
   * otherwise land entirely in the first sample, which drags the mean and
   * inflates the spread for reasons that have nothing to do with the change
   * under test.
   */
  warmup?: number;
}

export interface Stats {
  samples: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  /**
   * Spread from fastest to p95, as a fraction of the median. This is the number
   * that decides whether a surface can carry a budget at all: a case whose
   * spread is wider than the regression anyone would care about cannot detect
   * that regression, on any threshold.
   */
  spread: number;
}

export interface BenchResult extends Stats {
  name: string;
  surface: Surface;
  what: string;
  /** Calls per timed sample, so a reader knows a median is a per-op average. */
  repeats: number;
}

/** Percentile by nearest rank over an already-sorted ascending list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of an empty sample');
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

export function median(sorted: readonly number[]): number {
  if (sorted.length === 0) throw new Error('median of an empty sample');
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function summarise(durationsMs: readonly number[]): Stats {
  if (durationsMs.length === 0) throw new Error('no samples to summarise');
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
  // Population rather than sample variance: these are every iteration that ran,
  // not a draw from a larger set of them.
  const variance = sorted.reduce((sum, n) => sum + (n - mean) ** 2, 0) / sorted.length;
  const med = median(sorted);
  const min = sorted[0] as number;
  const p95 = percentile(sorted, 95);
  return {
    samples: sorted.length,
    minMs: min,
    medianMs: med,
    p95Ms: p95,
    maxMs: sorted[sorted.length - 1] as number,
    meanMs: mean,
    stddevMs: Math.sqrt(variance),
    // A median of zero means the case is below the clock's resolution, which is
    // a broken benchmark rather than an infinitely noisy one; report no spread
    // instead of dividing by it.
    spread: med === 0 ? 0 : (p95 - min) / med,
  };
}

const DEFAULT_ITERATIONS = 30;
const DEFAULT_WARMUP = 3;

export async function runCase(bench: BenchCase): Promise<BenchResult> {
  const iterations = bench.iterations ?? DEFAULT_ITERATIONS;
  const warmup = bench.warmup ?? DEFAULT_WARMUP;
  const repeats = bench.repeats ?? 1;
  await bench.setup?.();
  const durations: number[] = [];
  try {
    for (let i = 0; i < warmup; i++) await bench.run();
    for (let i = 0; i < iterations; i++) {
      const started = Bun.nanoseconds();
      for (let r = 0; r < repeats; r++) await bench.run();
      durations.push((Bun.nanoseconds() - started) / 1e6 / repeats);
    }
  } finally {
    // A case that allocates a temp directory has to clean it up even when an
    // iteration threw, or a failed run leaves the machine dirtier than it found it.
    await bench.teardown?.();
  }
  return {
    name: bench.name,
    surface: bench.surface,
    what: bench.what,
    repeats,
    ...summarise(durations),
  };
}
