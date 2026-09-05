import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchRun } from './bench/index.ts';
import { runBenchmarks, SURFACES } from './bench/index.ts';
import type { Surface } from './bench/runner.ts';

/**
 * Records performance baselines for the four surfaces M7 names.
 *
 * This enforces nothing and fails on no threshold, deliberately. Baselines have
 * to accumulate across machines and CI runs before anyone can say what a normal
 * spread looks like, and a budget picked before that is a coin flip that trains
 * people to rerun the job until it passes. Comparison is a later slice; what
 * this produces is the history it will need.
 *
 *   bun run bench                     # every surface, prints a table
 *   bun run bench --surface shaping   # one surface
 *   bun run bench --save              # also append to bench/baselines/
 */
const args = process.argv.slice(2);

function surfacesFrom(argv: string[]): Surface[] {
  const picked: Surface[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--surface') continue;
    const value = argv[i + 1];
    if (!value || !SURFACES.includes(value as Surface)) {
      console.error(`--surface must be one of: ${SURFACES.join(', ')}`);
      process.exit(2);
    }
    picked.push(value as Surface);
  }
  return picked.length > 0 ? picked : SURFACES;
}

function table(run: BenchRun): string {
  const rows = run.results.map((r) => ({
    name: r.name,
    median: `${r.medianMs.toFixed(3)} ms`,
    p95: `${r.p95Ms.toFixed(3)} ms`,
    // Printed next to the median rather than buried in the JSON: a reader
    // deciding whether this number can carry a budget needs both at once.
    spread: `${(r.spread * 100).toFixed(0)}%`,
    n: String(r.samples),
    what: r.what,
  }));
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    median: Math.max(6, ...rows.map((r) => r.median.length)),
    p95: Math.max(3, ...rows.map((r) => r.p95.length)),
    spread: Math.max(6, ...rows.map((r) => r.spread.length)),
    n: Math.max(1, ...rows.map((r) => r.n.length)),
  };
  const header = `${'case'.padEnd(widths.name)}  ${'median'.padStart(widths.median)}  ${'p95'.padStart(widths.p95)}  ${'spread'.padStart(widths.spread)}  ${'n'.padStart(widths.n)}  what`;
  const lines = rows.map(
    (r) =>
      `${r.name.padEnd(widths.name)}  ${r.median.padStart(widths.median)}  ${r.p95.padStart(widths.p95)}  ${r.spread.padStart(widths.spread)}  ${r.n.padStart(widths.n)}  ${r.what}`,
  );
  return [header, '-'.repeat(header.length), ...lines].join('\n');
}

console.error(`recording baselines on ${process.platform}/${process.arch}\n`);
const run = await runBenchmarks(surfacesFrom(args));

console.log(`\n${table(run)}`);
console.log(
  `\n${run.results.length} cases on ${run.platform}/${run.arch}, ${run.cpus} cpus, bun ${run.bunVersion}`,
);
console.log(
  'No thresholds are enforced. Spread is what decides which of these can carry a budget.',
);

if (args.includes('--save')) {
  const dir = join('bench', 'baselines');
  await mkdir(dir, { recursive: true });
  // One file per run rather than one rolling file: the point of the exercise is
  // the distribution across runs and machines, and overwriting keeps a sample
  // of one forever.
  const stamp = run.recordedAt.replace(/[:.]/g, '-');
  const path = join(dir, `${run.platform}-${run.arch}-${stamp}.json`);
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  console.log(`saved ${path}`);
}
