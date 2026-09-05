import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bun spawns through uv_spawn, which executes a file rather than searching
// PATHEXT the way a shell does. On Windows npm is `npm.cmd`, so a bare 'npm'
// is ENOENT there however npm was installed.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const temp = await mkdtemp(join(tmpdir(), 'earshot-npm-'));
try {
  const env = { ...process.env, npm_config_cache: join(temp, 'cache') };
  const pack = Bun.spawnSync([npm, 'pack', '--json', '--pack-destination', temp], {
    cwd: 'packages/cli',
    env,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (pack.exitCode !== 0) process.exit(pack.exitCode);
  const packed = JSON.parse(pack.stdout.toString()) as Array<{ filename: string }>;
  const filename = packed[0]?.filename;
  if (!filename) throw new Error('npm pack did not report an archive');

  const prefix = join(temp, 'prefix');
  const install = Bun.spawnSync(
    [npm, 'install', '--global', '--prefix', prefix, join(temp, filename)],
    {
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  if (install.exitCode !== 0) process.exit(install.exitCode);

  const executable = join(prefix, 'bin', process.platform === 'win32' ? 'earshot.cmd' : 'earshot');
  const run = Bun.spawnSync([executable, '--version'], { stdout: 'pipe', stderr: 'inherit' });
  if (run.exitCode !== 0) process.exit(run.exitCode);
  const expected = (
    JSON.parse(await readFile('packages/cli/package.json', 'utf8')) as { version: string }
  ).version;
  const actual = run.stdout.toString().trim();
  if (actual !== expected)
    throw new Error(`installed earshot printed ${actual}; expected ${expected}`);
  console.log(`installed ${filename} and ran earshot ${actual}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
