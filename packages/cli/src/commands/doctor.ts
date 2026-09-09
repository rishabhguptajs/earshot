import { spawnSync } from 'node:child_process';
import { access, constants, readFile, stat } from 'node:fs/promises';
import { homedir, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import {
  defaultModelOrigins,
  loadSettings,
  resolveShell,
  ShellNotFoundError,
  VERSION,
} from '@earshot/core';
import { buildRegistry, openrouterFreeModels, POOL_PROVIDER_ID } from '@earshot/providers';
import type { ParsedArgs } from '../args.ts';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  run?: (command: string, args: string[]) => { status: number | null; stdout: string };
}

const runCommand = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout.trim() };
};

async function writableLocation(path: string): Promise<boolean> {
  let candidate = path;
  while (true) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) candidate = dirname(candidate);
      await access(candidate, constants.W_OK);
      return true;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

async function jsonCheck(name: string, path: string): Promise<DoctorCheck | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    JSON.parse(raw);
    return { name, status: 'pass', detail: path };
  } catch (error) {
    return { name, status: 'fail', detail: `${path}: ${(error as Error).message}` };
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const hostPlatform = options.platform ?? platform();
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const run = options.run ?? runCommand;
  const configPath =
    env.EARSHOT_CONFIG_DIR ??
    (hostPlatform === 'win32'
      ? join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'earshot')
      : join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'earshot'));
  const dataPath =
    env.EARSHOT_DATA_DIR ??
    (hostPlatform === 'win32'
      ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'earshot')
      : join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'earshot'));
  const authPath = join(configPath, 'auth.json');
  const checks: DoctorCheck[] = [];

  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'runtime',
    status: nodeMajor >= 22 ? 'pass' : 'fail',
    detail: `Node ${nodeVersion}${process.versions.bun ? ` (Bun ${process.versions.bun})` : ''}`,
  });
  checks.push({ name: 'platform', status: 'pass', detail: `${hostPlatform} ${release()}` });

  const git = run('git', ['--version']);
  checks.push({
    name: 'git',
    status: git.status === 0 ? 'pass' : 'warn',
    detail: git.status === 0 ? git.stdout : 'not found; sessions work, but /undo is unavailable',
  });

  try {
    const shell = resolveShell(env, hostPlatform);
    checks.push({ name: 'shell', status: 'pass', detail: shell.file });
  } catch (error) {
    checks.push({
      name: 'shell',
      status: error instanceof ShellNotFoundError ? 'fail' : 'warn',
      detail: (error as Error).message,
    });
  }

  for (const [name, path] of [
    ['config directory', configPath],
    ['data directory', dataPath],
  ] as const) {
    checks.push({
      name,
      status: (await writableLocation(path)) ? 'pass' : 'fail',
      detail: path,
    });
  }

  const auth = await jsonCheck('auth file', authPath);
  if (auth) {
    if (hostPlatform !== 'win32' && auth.status === 'pass') {
      const mode = (await stat(authPath)).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        auth.status = 'fail';
        auth.detail += ` (permissions ${mode.toString(8)}; expected 600)`;
      }
    }
    checks.push(auth);
  }

  for (const [name, path] of [
    ['project settings', join(cwd, '.earshot', 'settings.json')],
    ['local settings', join(cwd, '.earshot', 'settings.local.json')],
    ['global settings', join(configPath, 'settings.json')],
  ] as const) {
    const check = await jsonCheck(name, path);
    if (check) checks.push(check);
  }

  const model = await modelCheck(cwd);
  if (model) checks.push(model);

  checks.unshift({ name: 'earshot', status: 'pass', detail: VERSION });
  return checks;
}

export async function doctorCommand(_args: ParsedArgs): Promise<number> {
  const checks = await runDoctor();
  for (const check of checks) {
    process.stdout.write(
      `${check.status.toUpperCase().padEnd(4)}  ${check.name.padEnd(18)} ${check.detail}\n`,
    );
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  process.stdout.write(
    `\n${failed === 0 ? 'ready' : 'not ready'}: ${failed} failed, ${warnings} warnings\n`,
  );
  return failed === 0 ? 0 : 1;
}

/**
 * Whether the configured default model still exists.
 *
 * Free model listings churn on a timescale of days, and a `defaultModel`
 * pointing at a retired one fails on the first turn of every session with an
 * error that says nothing about where the bad reference came from. This is the
 * cheapest place to find that out - and the case is not hypothetical: three
 * `:free` OpenRouter models named by a five-day-old catalog snapshot had
 * already ceased to exist, one of them somebody's saved default.
 */
async function modelCheck(cwd: string): Promise<DoctorCheck | undefined> {
  const settings = await loadSettings(cwd).catch(() => undefined);
  const ref = settings?.defaultModel;
  if (!ref) return undefined;

  const registry = buildRegistry({
    ...(settings?.pool.endpoints?.length ? { custom: settings.pool.endpoints } : {}),
  });
  // The pool's own tiers are not catalog entries; that they resolve at all is
  // what `earshot pool status` reports, and it needs credentials to say so.
  if (ref.startsWith(`${POOL_PROVIDER_ID}/`)) {
    return { name: 'default model', status: 'pass', detail: `${ref} (free pool)` };
  }

  // The pool is on but something narrower pins a concrete model: usually the
  // first-run picker's choice, saved into the project before the pool existed.
  // Every session then starts off the pool, and nothing says why.
  if (settings?.pool.enabled) {
    const origin = (await defaultModelOrigins(cwd)).findLast((one) => one.model === ref);
    return {
      name: 'default model',
      status: 'warn',
      detail:
        `pool is on, but ${origin?.path ?? 'settings'} pins "${ref}" - ` +
        'run `earshot pool enable` again to start sessions on free/best',
    };
  }

  // OpenRouter's free listing is the one the catalog is reliably wrong about,
  // and the one most likely to be sitting in someone's `defaultModel`. The
  // cached live listing is consulted, never fetched: `doctor` contacts nothing.
  if (ref.startsWith('openrouter/')) {
    const free = await openrouterFreeModels({ cachedOnly: true });
    const id = ref.slice('openrouter/'.length);
    if (free.length > 0 && ref.includes(':free') && !free.some((one) => one.id === id)) {
      return {
        name: 'default model',
        status: 'warn',
        detail: `"${ref}" is no longer free on OpenRouter - run \`/model\` to pick another`,
      };
    }
  }

  return registry.resolveModel(ref)
    ? { name: 'default model', status: 'pass', detail: ref }
    : {
        name: 'default model',
        status: 'warn',
        detail: `"${ref}" is no longer in the catalog - run \`earshot models\` and \`/model\` to pick another`,
      };
}
