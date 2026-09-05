import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchCase } from '../runner.ts';
import type { Suite } from './session.ts';

const BIN = 'packages/cli/bin/earshot.js';

/**
 * Startup is measured through the real binary, not by importing main.ts: what a
 * user waits for is process spawn, module resolution and Node's own boot, and
 * an in-process import measures none of those. It is also the only surface here
 * that cannot be measured without `bun run build` having run first.
 */
export async function startupCases(): Promise<Suite> {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing - run \`bun run build\` before benchmarking startup`);
  }

  // doctor inspects the environment, so it is pointed at a throwaway config and
  // data dir: it must not read the operator's real credentials, and it must not
  // report differently depending on whose machine the baseline was recorded on.
  const root = await mkdtemp(join(tmpdir(), 'earshot-bench-cli-'));
  const env = {
    ...process.env,
    EARSHOT_CONFIG_DIR: join(root, 'config'),
    EARSHOT_DATA_DIR: join(root, 'data'),
  };

  const spawn = async (args: string[]) => {
    const proc = Bun.spawn(['node', BIN, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(
        `earshot ${args.join(' ')} exited ${code}: ${await new Response(proc.stderr).text()}`,
      );
    }
  };

  return {
    cleanup: () => rm(root, { recursive: true, force: true }),
    cases: [
      {
        name: 'startup/version',
        surface: 'startup',
        // The floor for every other command: nothing but boot and argument
        // parsing, so a rise here is a rise in everything the CLI does.
        what: 'spawn to exit for `earshot --version`',
        iterations: 15,
        run: () => spawn(['--version']),
      },
      {
        name: 'startup/doctor',
        surface: 'startup',
        what: 'spawn to exit for `earshot doctor`',
        iterations: 15,
        run: () => spawn(['doctor']),
      },
    ] satisfies BenchCase[],
  };
}
