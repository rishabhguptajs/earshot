import { rm } from 'node:fs/promises';

/**
 * Bundles the workspace into the single publishable `earshot` package: the
 * internal @earshot/* packages are inlined rather than published separately.
 * Uses Bun.build directly - the bundler is the only thing we need from a build
 * tool, and this keeps the dev dependency surface at zero.
 */
/** Everything published as a dependency of `earshot` rather than inlined. */
const EXTERNAL = ['@ai-sdk/*', 'ai', 'zod'];

const outdir = 'packages/cli/dist';
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ['packages/cli/src/main.ts'],
  outdir,
  target: 'node',
  format: 'esm',
  sourcemap: 'linked',
  // Provider SDKs stay external and are installed as real dependencies: bundling
  // them inlines the AWS and Google SDKs and pushes the package past 10 MB, which
  // is not something to hand someone running `npm i -g earshot`.
  external: EXTERNAL,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const bytes = result.outputs.reduce((n, o) => n + o.size, 0);
console.log(`built ${result.outputs.length} files (${(bytes / 1024).toFixed(1)} kB) -> ${outdir}`);
