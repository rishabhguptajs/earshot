import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@earshot/core';
import type { ParsedArgs } from '../args.ts';

const PACKAGE = '@raegent/earshot';
const REPO = 'rishabhguptajs/earshot';
const REGISTRY = `https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}/latest`;
const RELEASE = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * Marks Bun leaves in a `--compile`d executable. The entry module lives in a
 * virtual filesystem rather than on disk, and its path is the only signal that
 * survives the user renaming or symlinking the binary.
 *
 * Note what is *not* usable here:
 *
 * - `process.versions.bun` is set when running from source under Bun too.
 * - `basename(process.execPath)` is whatever the file was renamed to.
 * - `existsSync(Bun.main)` returns true inside a compiled binary - Bun
 *   intercepts `fs` for these paths - so the obvious "is the entry a real
 *   file?" check reports the wrong answer rather than failing loudly.
 *
 * The Windows form is Bun's documented layout rather than something verified on
 * a Windows host, so `detectInstall` corroborates a marker hit with
 * `process.versions.bun` being set. If a future Bun renames these, detection
 * degrades to `unknown` - a message and exit 2 - and never to a branch that
 * would try to overwrite the `node` interpreter.
 */
const BUNFS_MARKERS = ['/$bunfs/', '\\$bunfs\\', '/~BUN/', '\\~BUN\\'];

/** Release asset names, from `scripts/build-binaries.ts`. */
const ASSETS: Record<string, string> = {
  'darwin-arm64': 'earshot-darwin-arm64',
  'darwin-x64': 'earshot-darwin-x64',
  'linux-x64': 'earshot-linux-x64',
  'linux-arm64': 'earshot-linux-arm64',
  'win32-x64': 'earshot-windows-x64.exe',
};

export type InstallKind = 'binary' | 'npm' | 'source' | 'unknown';

/** Which package manager's global tree the npm install actually sits in. */
export type Manager = 'npm' | 'bun' | 'pnpm' | 'volta' | 'yarn';

export interface Install {
  kind: InstallKind;
  /** For `binary`, the executable to replace. For `npm`, the package directory. */
  path?: string;
  /** `npm` only: which manager owns the tree, and whether it is a project install. */
  manager?: Manager;
  local?: boolean;
  /** `binary` only: the release asset that matches this host, if there is one. */
  asset?: string;
  /** Why an install is not updatable, for the `unknown`/`source` message. */
  reason?: string;
}

export interface DetectOptions {
  execPath: string;
  moduleUrl: string;
  bunVersion?: string | undefined;
  platform: NodeJS.Platform;
  arch: string;
  /** Resolves symlinks; injected so tests need no real filesystem. */
  realpath?: (path: string) => string;
  /** Reports whether a `package.json` sits beside a `node_modules` directory. */
  isProjectRoot?: (dir: string) => boolean;
}

function modulePath(moduleUrl: string): string {
  try {
    return fileURLToPath(moduleUrl);
  } catch {
    // A `$bunfs` URL is not a real file URL on every platform; the marker test
    // below only needs the raw string.
    return moduleUrl;
  }
}

/** Classifies the global tree a package directory sits in by its shape. */
function managerOf(dir: string): Manager {
  const lower = dir.toLowerCase().replaceAll('\\', '/');
  if (lower.includes('/.bun/install/global')) return 'bun';
  if (lower.includes('/.volta/')) return 'volta';
  if (lower.includes('/pnpm/global') || lower.includes('/.pnpm/')) return 'pnpm';
  if (lower.includes('/.yarn/') || lower.includes('/yarn/global')) return 'yarn';
  return 'npm';
}

/**
 * Works out how the running earshot was installed.
 *
 * Pure: every host fact arrives as an option, so the tests drive it with the
 * observed values for each form rather than by installing anything.
 */
export function detectInstall(options: DetectOptions): Install {
  const { execPath, moduleUrl, bunVersion, platform, arch } = options;
  const realpath = options.realpath ?? ((path: string) => path);
  const file = modulePath(moduleUrl);

  if (BUNFS_MARKERS.some((marker) => file.includes(marker)) && bunVersion !== undefined) {
    const asset = ASSETS[`${platform}-${arch}`];
    const target = realpath(execPath);
    if (asset === undefined) {
      return {
        kind: 'binary',
        path: target,
        reason: `no release asset is built for ${platform}-${arch}`,
      };
    }
    return { kind: 'binary', path: target, asset };
  }

  const marker = `${sep}node_modules${sep}${PACKAGE.split('/').join(sep)}${sep}`;
  const index = `${file}${sep}`.indexOf(marker);
  if (index !== -1) {
    const packageDir = file.slice(0, index + marker.length - 1);
    const tree = packageDir.slice(0, packageDir.indexOf(`${sep}node_modules${sep}`));
    const isProjectRoot = options.isProjectRoot ?? (() => false);
    return {
      kind: 'npm',
      path: packageDir,
      manager: managerOf(packageDir),
      local: isProjectRoot(tree),
    };
  }

  if (file.includes(`${sep}packages${sep}cli${sep}`) || file.endsWith('.ts')) {
    return { kind: 'source', path: file, reason: 'running from a source checkout' };
  }
  return { kind: 'unknown', path: file, reason: `cannot tell how ${execPath} was installed` };
}

/** `1.2.3` ordering; any prerelease sorts below the release it belongs to. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const [core = '', pre] = value.replace(/^v/, '').split('-');
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { parts, pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * While the repository is private, every release URL - the API and the asset
 * downloads alike - answers an unauthenticated request with 404 rather than
 * 403, so "not found" and "not allowed" are the same response. A token in the
 * environment is the only thing that separates them, and `gh` already puts one
 * there for the people who can see these releases at all.
 */
export function releaseAuth(env: NodeJS.ProcessEnv): RequestInit {
  const token = env.EARSHOT_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
  return token ? { headers: { authorization: `Bearer ${token}` } } : {};
}

/** What a 404 from a release URL actually means, given whether we had a token. */
export function releaseNotFound(env: NodeJS.ProcessEnv): string {
  return releaseAuth(env).headers === undefined
    ? 'GitHub returned 404. The releases are not public, so this needs a token: ' +
        'set GITHUB_TOKEN (or GH_TOKEN) to one that can read the repository.'
    : 'GitHub returned 404 for the token in GITHUB_TOKEN; it may not have access ' +
        'to this repository.';
}

export interface Release {
  version: string;
  /** Asset name to the API download URL for it. */
  assets: Record<string, string>;
}

/**
 * The newest release, with its assets addressed by their API URL rather than
 * the `releases/download/...` browser URL. The browser URL ignores a bearer
 * token and answers 404 for a private repository; the asset API endpoint
 * accepts one, and works identically once the repository is public, so there is
 * no reason to have two paths.
 */
export async function fetchRelease(fetchImpl: Fetch, env: NodeJS.ProcessEnv): Promise<Release> {
  const response = await fetchImpl(RELEASE, releaseAuth(env));
  if (response.status === 404) throw new Error(releaseNotFound(env));
  if (!response.ok) throw new Error(`GitHub releases returned ${response.status}`);
  const body = (await response.json()) as {
    tag_name?: string;
    assets?: { name: string; url: string }[];
  };
  if (!body.tag_name) throw new Error('GitHub returned a release with no tag');
  const assets: Record<string, string> = {};
  for (const asset of body.assets ?? []) assets[asset.name] = asset.url;
  return { version: body.tag_name.replace(/^v/, ''), assets };
}

/** The newest published version for this install form. */
export async function resolveLatest(
  kind: InstallKind,
  fetchImpl: Fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (kind === 'npm') {
    const response = await fetchImpl(REGISTRY);
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    const body = (await response.json()) as { version?: string };
    if (!body.version) throw new Error('npm registry returned no version');
    return body.version;
  }
  return (await fetchRelease(fetchImpl, env)).version;
}

/**
 * `sha256sum artifacts/*` in the release workflow leaves the `artifacts/`
 * prefix on every path, so the name is matched on its basename rather than on
 * the whole field.
 */
export function findChecksum(sums: string, asset: string): string | undefined {
  for (const line of sums.split('\n')) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    const name = rest.join(' ').replace(/^\*/, '');
    if (hash && name && basename(name) === asset) return hash.toLowerCase();
  }
  return undefined;
}

export interface UpdateOptions {
  install?: Install;
  current?: string;
  fetch?: Fetch;
  check?: boolean;
  yes?: boolean;
  /** Answers the confirmation. Absent means non-interactive: never act. */
  confirm?: (question: string) => Promise<boolean>;
  run?: (command: string, args: string[]) => { status: number | null };
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Injected so the Windows replace path is testable from any host. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const installCommand: Record<Manager, string> = {
  npm: `npm install -g ${PACKAGE}@latest`,
  bun: `bun add -g ${PACKAGE}@latest`,
  pnpm: `pnpm add -g ${PACKAGE}@latest`,
  yarn: `yarn global add ${PACKAGE}@latest`,
  volta: `volta install ${PACKAGE}@latest`,
};

export async function runUpdate(options: UpdateOptions = {}): Promise<number> {
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((text: string) => process.stderr.write(text));
  const current = options.current ?? VERSION;
  const install =
    options.install ??
    detectInstall({
      execPath: process.execPath,
      moduleUrl: import.meta.url,
      bunVersion: process.versions.bun,
      platform: process.platform,
      arch: process.arch,
      realpath: (path) => {
        try {
          return realpathSync(path);
        } catch {
          return path;
        }
      },
      isProjectRoot: (dir) => existsSync(join(dir, 'package.json')),
    });
  const fetchImpl = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));

  if (install.kind === 'source' || install.kind === 'unknown') {
    err(`earshot update: ${install.reason}\n`);
    err(
      install.kind === 'source'
        ? 'update the checkout with git instead\n'
        : `reinstall from ${`https://github.com/${REPO}/releases`}\n`,
    );
    return 2;
  }
  if (install.kind === 'binary' && install.asset === undefined) {
    err(`earshot update: ${install.reason}\n`);
    return 2;
  }

  // The binary path needs the asset URLs from the same release it read the
  // version off, so it fetches the release rather than just the version.
  let latest: string;
  let release: Release | undefined;
  try {
    if (install.kind === 'binary') {
      release = await fetchRelease(fetchImpl, options.env ?? process.env);
      latest = release.version;
    } else {
      latest = await resolveLatest(install.kind, fetchImpl, options.env ?? process.env);
    }
  } catch (error) {
    err(`earshot update: ${(error as Error).message}\n`);
    return 1;
  }

  if (compareVersions(current, latest) >= 0) {
    out(`earshot ${current} is the latest version\n`);
    return 0;
  }

  const where =
    install.kind === 'npm'
      ? `installed with ${install.manager}, ${install.local ? 'in this project' : 'globally'}`
      : 'standalone binary';
  out(`earshot ${current}  ->  ${latest}   (${where})\n`);

  if (install.kind === 'npm') {
    const manager = install.manager ?? 'npm';
    const command = install.local
      ? `${manager === 'npm' ? 'npm install' : `${manager} add`} ${PACKAGE}@latest`
      : installCommand[manager];
    out(`\n  ${command}\n\n`);

    // Only an npm-shaped global tree is upgraded automatically. Running
    // `npm install -g` over a bun, pnpm, volta or yarn install does not replace
    // it: it installs a second copy at a different prefix and leaves which one
    // wins to PATH order. A project-local install is the user's project to
    // change, not ours.
    if (install.local || manager !== 'npm') {
      out('run that to update\n');
      return options.check ? 4 : 0;
    }
    if (options.check) return 4;
    if (!(await confirmed(options, 'run it now?'))) {
      out('run that to update\n');
      return 0;
    }
    const run = options.run ?? runCommand;
    const result = run('npm', ['install', '-g', `${PACKAGE}@latest`]);
    if (result.status !== 0) {
      err(`earshot update: npm exited ${result.status}\n`);
      return 1;
    }
    out(`updated to ${latest}\n`);
    return 0;
  }

  return await updateBinary(install, release as Release, options, out, err);
}

function runCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
  return { status: result.status };
}

async function confirmed(options: UpdateOptions, question: string): Promise<boolean> {
  if (options.yes) return true;
  const confirm = options.confirm ?? defaultConfirm;
  return await confirm(question);
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function updateBinary(
  install: Install,
  release: Release,
  options: UpdateOptions,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const target = install.path as string;
  const asset = install.asset as string;
  const dir = dirname(target);
  const latest = release.version;
  const fetchImpl = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));

  // Sweep what a previous Windows update had to leave behind (see below).
  await sweepStale(dir, target);

  out(`  ${target}   ${asset}\n`);
  if (options.check) return 4;

  // Fail on an unwritable location before spending a download on it.
  try {
    await writeFile(join(dir, `.earshot-update-probe-${process.pid}`), '');
    await rm(join(dir, `.earshot-update-probe-${process.pid}`), { force: true });
  } catch {
    err(`earshot update: cannot write to ${dir}\n`);
    err('re-run with the permissions that own that directory\n');
    return 1;
  }

  if (!(await confirmed(options, `download ${asset} and replace it?`))) {
    out('nothing was changed\n');
    return 0;
  }

  const assetUrl = release.assets[asset];
  const sumsUrl = release.assets.SHA256SUMS;
  if (assetUrl === undefined || sumsUrl === undefined) {
    err(`earshot update: release v${latest} does not publish ${assetUrl ? 'SHA256SUMS' : asset}\n`);
    return 1;
  }

  const temp = join(dir, `.earshot-update-${process.pid}.tmp`);
  try {
    // The asset API endpoint serves the bytes only when asked for them; without
    // this it answers with the asset's JSON metadata instead.
    const auth = releaseAuth(options.env ?? process.env);
    const octet: RequestInit = {
      ...auth,
      headers: { ...(auth.headers as Record<string, string>), accept: 'application/octet-stream' },
    };

    out('  downloading… ');
    const download = await fetchImpl(assetUrl, octet);
    if (download.status === 404) throw new Error(releaseNotFound(options.env ?? process.env));
    if (!download.ok) throw new Error(`downloading ${asset} returned ${download.status}`);
    const bytes = new Uint8Array(await download.arrayBuffer());

    out('verifying SHA256… ');
    const sumsResponse = await fetchImpl(sumsUrl, octet);
    if (!sumsResponse.ok) throw new Error(`SHA256SUMS returned ${sumsResponse.status}`);
    const expected = findChecksum(await sumsResponse.text(), asset);
    if (expected === undefined) throw new Error(`SHA256SUMS does not list ${asset}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }

    out('replacing… ');
    await writeFile(temp, bytes);
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') await chmod(temp, 0o755);
    await replace(temp, target, platform);
    out(`\nupdated to ${latest}\n`);
    return 0;
  } catch (error) {
    await rm(temp, { force: true });
    out('\n');
    err(`earshot update: ${(error as Error).message}\n`);
    err('nothing was replaced\n');
    return 1;
  }
}

export interface ReplaceIo {
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
}

const realIo: ReplaceIo = {
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
};

/**
 * Puts the downloaded binary where the running one is.
 *
 * POSIX: a single `rename` is atomic, and this process keeps executing from the
 * inode it already opened, so the in-flight update finishes normally.
 *
 * Windows: a running `.exe` cannot be deleted or overwritten, but it *can* be
 * renamed on the same volume while it executes. So the running image is moved
 * aside and the new one takes its place; deleting the old name fails while the
 * process lives, and is left for the next run's sweep rather than reported as
 * an error the user cannot act on.
 */
export async function replace(
  temp: string,
  target: string,
  platform: NodeJS.Platform,
  io: ReplaceIo = realIo,
): Promise<void> {
  if (platform !== 'win32') {
    await io.rename(temp, target);
    return;
  }
  const aside = `${target}.old-${process.pid}`;
  await io.rename(target, aside);
  try {
    await io.rename(temp, target);
  } catch (error) {
    await io.rename(aside, target).catch(() => {});
    throw error;
  }
  // Fails while this process is still executing the old image; the next run's
  // sweep collects it. Not an error the user can do anything about.
  await io.remove(aside).catch(() => {});
}

/** Removes `.old-*` images an earlier Windows update could not delete. */
async function sweepStale(dir: string, target: string): Promise<void> {
  const prefix = `${basename(target)}.old-`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry.startsWith(prefix)) await rm(join(dir, entry), { force: true }).catch(() => {});
  }
}

export async function updateCommand(args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) {
    process.stderr.write(`earshot update: unexpected argument "${args.positionals[0]}"\n`);
    process.stderr.write('usage: earshot update [--check] [--yes]\n');
    return 2;
  }
  return runUpdate({
    check: args.flags.check === true,
    yes: args.flags.yes === true || args.flags.y === true,
  });
}
