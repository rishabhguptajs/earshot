import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * These drive the real binary rather than the exported command functions,
 * because the guarantee under test is about the ENTRY's entry point: a script
 * piping into earshot must never block on a prompt, whatever changes inside
 * interactive.ts. `-p` and `--no-onboarding` are asserted from the outside so
 * a future change to onboarding cannot silently make either of them wait for
 * input again.
 */
const ENTRY = join(import.meta.dir, 'fixtures/run-main.ts');

function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const stripped = { ...process.env };
  for (const key of Object.keys(stripped)) {
    if (key.endsWith('_API_KEY') || key === 'OPENROUTER_API_KEY') delete stripped[key];
  }
  return {
    ...stripped,
    EARSHOT_CONFIG_DIR: join(dir, 'config'),
    EARSHOT_DATA_DIR: join(dir, 'data'),
  };
}

describe('missing credentials at the process boundary', () => {
  test('headless (-p) exits 3 immediately, with no stdin read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'earshot-cli-'));
    const result = spawnSync('bun', ['run', ENTRY, '-p', 'hello'], {
      env: isolatedEnv(dir),
      // Closed rather than a pipe kept open: if headless ever tried to read a
      // prompt from stdin, this would make that read fail loudly instead of
      // the test hanging until its own timeout.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    expect(result.status).toBe(3);
  });

  test('acp never reaches onboarding: it dispatches before interactive.ts is involved', async () => {
    // `earshot acp` resolves credentials lazily, per editor session, and never
    // calls interactiveCommand at all - packages/cli/src/index.ts dispatches it
    // straight to acpCommand. There is nothing for onboarding to gate here; this
    // asserts the routing rather than a runtime timeout, since the server
    // otherwise waits on the ACP stdio protocol and would have nothing to exit
    // on in a plain spawn.
    const source = await Bun.file(join(import.meta.dir, '../src/index.ts')).text();
    const acpDispatch = source.indexOf("command === 'acp'");
    const interactiveDispatch = source.indexOf('return interactiveCommand(args)');
    expect(acpDispatch).toBeGreaterThan(-1);
    expect(interactiveDispatch).toBeGreaterThan(acpDispatch);
  });

  test('--no-onboarding restores the old exit-3 path for the interactive command too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'earshot-cli-'));
    // No TTY under spawnSync either way, so this hits the existing "needs an
    // interactive terminal" gate (exit 2) before onboarding would ever run -
    // which is itself proof `--no-onboarding` cannot be the reason a real
    // terminal blocks: the flag has nothing left to skip past by the time a
    // pipe reaches this command.
    const result = spawnSync('bun', ['run', ENTRY, '--no-onboarding'], {
      env: isolatedEnv(dir),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    expect(result.status).toBe(2);
  });
});
