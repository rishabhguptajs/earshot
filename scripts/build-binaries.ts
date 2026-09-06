import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const targets = {
  'darwin-arm64': 'bun-darwin-arm64',
  // The non-baseline target assumes AVX2. Real Intel Macs old enough to lack
  // it hit the same "Illegal instruction" crash as Rosetta 2 does translating
  // it on Apple Silicon - baseline is the only target that runs everywhere
  // x64 macOS actually is, CI included.
  'darwin-x64': 'bun-darwin-x64-baseline',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'windows-x64': 'bun-windows-x64',
} as const;

type Target = keyof typeof targets;
const requested = process.argv.slice(2);
const selected = (requested.length === 0 ? Object.keys(targets) : requested) as Target[];
for (const target of selected) {
  if (!(target in targets)) {
    console.error(`unknown target "${target}"; choose: ${Object.keys(targets).join(', ')}`);
    process.exit(2);
  }
}

const outdir = join(process.cwd(), 'artifacts');
await mkdir(outdir, { recursive: true });

for (const target of selected) {
  const name = `earshot-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
  const outfile = join(outdir, name);
  await rm(outfile, { force: true });
  const proc = Bun.spawn(
    [
      process.execPath,
      'build',
      'packages/cli/src/main.ts',
      '--compile',
      `--target=${targets[target]}`,
      `--outfile=${outfile}`,
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      '--no-compile-autoload-tsconfig',
      '--no-compile-autoload-package-json',
    ],
    { cwd: process.cwd(), stdout: 'inherit', stderr: 'inherit' },
  );
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}
