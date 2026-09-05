import { renderingCases } from '../../packages/tui/bench/cases.tsx';
import type { Suite } from './cases/session.ts';
import { sessionCases } from './cases/session.ts';
import { shapingCases } from './cases/shaping.ts';
import { startupCases } from './cases/startup.ts';
import type { BenchResult, Surface } from './runner.ts';
import { runCase } from './runner.ts';

export interface BenchRun {
  /** Enough to tell two baselines apart when their numbers disagree. */
  recordedAt: string;
  platform: string;
  arch: string;
  cpus: number;
  bunVersion: string;
  results: BenchResult[];
}

const SURFACES: Surface[] = ['startup', 'rendering', 'shaping', 'session'];

async function suites(only: Surface[]): Promise<Suite[]> {
  const wanted = new Set(only);
  const built: Suite[] = [];
  if (wanted.has('shaping')) built.push({ cases: shapingCases(), cleanup: async () => {} });
  if (wanted.has('session')) built.push(await sessionCases());
  if (wanted.has('rendering')) built.push(renderingCases());
  if (wanted.has('startup')) built.push(await startupCases());
  return built;
}

export async function runBenchmarks(only: Surface[] = SURFACES): Promise<BenchRun> {
  const built = await suites(only);
  const results: BenchResult[] = [];
  try {
    for (const suite of built) {
      for (const bench of suite.cases) {
        const result = await runCase(bench);
        results.push(result);
        console.error(
          `  ${result.name.padEnd(28)} ${result.medianMs.toFixed(3).padStart(9)} ms  ±${(result.spread * 100).toFixed(0)}%`,
        );
      }
    }
  } finally {
    // Cleanup runs even when a case threw: a benchmark that aborts halfway must
    // not leave temp directories or an overridden EARSHOT_DATA_DIR behind.
    for (const suite of built) await suite.cleanup();
  }

  return {
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    cpus: (await import('node:os')).cpus().length,
    bunVersion: Bun.version,
    results,
  };
}

export { SURFACES };
