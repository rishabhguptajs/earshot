import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../../core/test/helpers.ts';
import {
  compareVersions,
  detectInstall,
  findChecksum,
  type Install,
  replace,
  runUpdate,
} from '../src/commands/update.ts';

/**
 * The values below are what each install form actually reports, captured by
 * running a probe under a `bun build --compile` executable, under `bun`, and
 * under `node`. They are the fixtures the detection has to separate.
 */
const OBSERVED = {
  binary: {
    execPath: '/Users/x/.local/bin/earshot',
    moduleUrl: 'file:///$bunfs/root/earshot',
    bunVersion: '1.3.4',
  },
  source: {
    execPath: '/Users/x/.bun/bin/bun',
    moduleUrl: 'file:///Users/x/dev/harness/packages/cli/src/main.ts',
    bunVersion: '1.3.4',
  },
  npm: {
    execPath: '/usr/local/bin/node',
    moduleUrl: 'file:///usr/local/lib/node_modules/@raegent/earshot/dist/main.js',
    bunVersion: undefined,
  },
} as const;

const host = { platform: 'darwin' as NodeJS.Platform, arch: 'arm64' };

function capture() {
  const lines: string[] = [];
  return { lines, write: (text: string) => void lines.push(text), text: () => lines.join('') };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('detectInstall', () => {
  test('separates a compiled binary from Bun running the source', () => {
    const binary = detectInstall({ ...OBSERVED.binary, ...host });
    expect(binary.kind).toBe('binary');
    expect(binary.path).toBe('/Users/x/.local/bin/earshot');
    expect(binary.asset).toBe('earshot-darwin-arm64');

    // Same runtime, same `process.versions.bun`, different install: only the
    // $bunfs entry path tells these apart.
    expect(detectInstall({ ...OBSERVED.source, ...host }).kind).toBe('source');
  });

  test('resolves a symlinked binary to the file it points at', () => {
    const install = detectInstall({
      ...OBSERVED.binary,
      ...host,
      realpath: (path) =>
        path.endsWith('/earshot') ? '/Users/x/.local/earshot-darwin-arm64' : path,
    });
    expect(install.path).toBe('/Users/x/.local/earshot-darwin-arm64');
  });

  test('reports no asset for a platform the release does not build', () => {
    const install = detectInstall({ ...OBSERVED.binary, platform: 'freebsd', arch: 'arm64' });
    expect(install.kind).toBe('binary');
    expect(install.asset).toBeUndefined();
    expect(install.reason).toContain('freebsd-arm64');
  });

  test('finds an npm install and the manager whose tree it sits in', () => {
    const global = detectInstall({ ...OBSERVED.npm, ...host });
    expect(global.kind).toBe('npm');
    expect(global.manager).toBe('npm');
    expect(global.local).toBe(false);

    const bun = detectInstall({
      ...OBSERVED.npm,
      ...host,
      moduleUrl: 'file:///Users/x/.bun/install/global/node_modules/@raegent/earshot/dist/main.js',
    });
    expect(bun.manager).toBe('bun');
  });

  test('marks a project-local install', () => {
    const install = detectInstall({
      ...OBSERVED.npm,
      ...host,
      moduleUrl: 'file:///Users/x/app/node_modules/@raegent/earshot/dist/main.js',
      isProjectRoot: (dir) => dir === '/Users/x/app',
    });
    expect(install.local).toBe(true);
  });
});

describe('compareVersions', () => {
  test('orders releases and sorts a prerelease below its release', () => {
    expect(compareVersions('0.2.0', '0.3.1')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
  });
});

describe('findChecksum', () => {
  test('matches on the basename, past the artifacts/ prefix the workflow leaves', () => {
    const sums = 'aa11  artifacts/earshot-linux-x64\nbb22  artifacts/earshot-darwin-arm64\n';
    expect(findChecksum(sums, 'earshot-darwin-arm64')).toBe('bb22');
    expect(findChecksum(sums, 'earshot-windows-x64.exe')).toBeUndefined();
  });
});

describe('earshot update', () => {
  test('says so and exits 0 when already current', async () => {
    const out = capture();
    const code = await runUpdate({
      install: { kind: 'npm', path: '/n', manager: 'npm', local: false },
      current: '0.3.1',
      fetch: async () => json({ version: '0.3.1' }),
      out: out.write,
    });
    expect(code).toBe(0);
    expect(out.text()).toContain('0.3.1 is the latest version');
  });

  test('exits 2 on a source checkout without touching the network', async () => {
    const err = capture();
    const code = await runUpdate({
      install: { kind: 'source', path: '/repo', reason: 'running from a source checkout' },
      current: '0.2.0',
      fetch: async () => {
        throw new Error('should not have fetched');
      },
      err: err.write,
    });
    expect(code).toBe(2);
    expect(err.text()).toContain('git');
  });

  test('exits 4 from --check when an update is available', async () => {
    const code = await runUpdate({
      install: { kind: 'npm', path: '/n', manager: 'npm', local: false },
      current: '0.2.0',
      check: true,
      fetch: async () => json({ version: '0.3.1' }),
      out: () => {},
    });
    expect(code).toBe(4);
  });

  test('runs npm only after the confirmation is answered yes', async () => {
    const install: Install = { kind: 'npm', path: '/n', manager: 'npm', local: false };
    const calls: string[][] = [];
    const declined = await runUpdate({
      install,
      current: '0.2.0',
      fetch: async () => json({ version: '0.3.1' }),
      confirm: async () => false,
      run: (command, args) => {
        calls.push([command, ...args]);
        return { status: 0 };
      },
      out: () => {},
    });
    expect(declined).toBe(0);
    expect(calls).toEqual([]);

    const out = capture();
    const accepted = await runUpdate({
      install,
      current: '0.2.0',
      fetch: async () => json({ version: '0.3.1' }),
      confirm: async () => true,
      run: (command, args) => {
        calls.push([command, ...args]);
        return { status: 0 };
      },
      out: out.write,
    });
    expect(accepted).toBe(0);
    expect(calls).toEqual([['npm', 'install', '-g', '@raegent/earshot@latest']]);
    expect(out.text()).toContain('updated to 0.3.1');
  });

  test('prints the owning manager rather than running npm over a bun install', async () => {
    const calls: string[][] = [];
    const out = capture();
    const code = await runUpdate({
      install: { kind: 'npm', path: '/n', manager: 'bun', local: false },
      current: '0.2.0',
      fetch: async () => json({ version: '0.3.1' }),
      yes: true,
      run: (command, args) => {
        calls.push([command, ...args]);
        return { status: 0 };
      },
      out: out.write,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(out.text()).toContain('bun add -g @raegent/earshot@latest');
  });

  test('reports a failed npm as exit 1', async () => {
    const code = await runUpdate({
      install: { kind: 'npm', path: '/n', manager: 'npm', local: false },
      current: '0.2.0',
      fetch: async () => json({ version: '0.3.1' }),
      yes: true,
      run: () => ({ status: 1 }),
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(1);
  });

  test('replaces the binary after verifying it against SHA256SUMS', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'earshot');
      await writeFile(target, 'old binary');
      const payload = new TextEncoder().encode('new binary');
      const hash = createHash('sha256').update(payload).digest('hex');
      const out = capture();

      const code = await runUpdate({
        install: { kind: 'binary', path: target, asset: 'earshot-darwin-arm64' },
        current: '0.2.0',
        yes: true,
        fetch: async (url) => {
          if (url.includes('api.github.com')) return json({ tag_name: 'v0.3.1' });
          if (url.endsWith('SHA256SUMS')) {
            return new Response(`${hash}  artifacts/earshot-darwin-arm64\n`, { status: 200 });
          }
          return new Response(payload, { status: 200 });
        },
        out: out.write,
      });

      expect(code).toBe(0);
      expect(out.text()).toContain('updated to 0.3.1');
      expect(await readFile(target, 'utf8')).toBe('new binary');
    });
  });

  test('leaves the running binary alone when the checksum does not match', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'earshot');
      await writeFile(target, 'old binary');
      const err = capture();

      const code = await runUpdate({
        install: { kind: 'binary', path: target, asset: 'earshot-darwin-arm64' },
        current: '0.2.0',
        yes: true,
        fetch: async (url) => {
          if (url.includes('api.github.com')) return json({ tag_name: 'v0.3.1' });
          if (url.endsWith('SHA256SUMS')) {
            return new Response(`${'0'.repeat(64)}  artifacts/earshot-darwin-arm64\n`, {
              status: 200,
            });
          }
          return new Response(new TextEncoder().encode('tampered'), { status: 200 });
        },
        out: () => {},
        err: err.write,
      });

      expect(code).toBe(1);
      expect(err.text()).toContain('checksum mismatch');
      expect(err.text()).toContain('nothing was replaced');
      expect(await readFile(target, 'utf8')).toBe('old binary');
      // The half-finished download does not survive the failure.
      expect((await readdir(dir)).filter((f) => f.includes('update'))).toEqual([]);
    });
  });

  test('sweeps a .old image an earlier Windows update could not delete', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'earshot');
      await writeFile(target, 'old binary');
      await writeFile(`${target}.old-4321`, 'stranded');
      const payload = new TextEncoder().encode('new binary');
      const hash = createHash('sha256').update(payload).digest('hex');

      await runUpdate({
        install: { kind: 'binary', path: target, asset: 'earshot-darwin-arm64' },
        current: '0.2.0',
        yes: true,
        fetch: async (url) => {
          if (url.includes('api.github.com')) return json({ tag_name: 'v0.3.1' });
          if (url.endsWith('SHA256SUMS')) {
            return new Response(`${hash}  artifacts/earshot-darwin-arm64\n`, { status: 200 });
          }
          return new Response(payload, { status: 200 });
        },
        out: () => {},
      });

      expect(await readdir(dir)).toEqual(['earshot']);
    });
  });

  test('a declined binary update downloads nothing', async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, 'earshot');
      await writeFile(target, 'old binary');
      const out = capture();
      const code = await runUpdate({
        install: { kind: 'binary', path: target, asset: 'earshot-darwin-arm64' },
        current: '0.2.0',
        confirm: async () => false,
        fetch: async (url) => {
          if (url.includes('api.github.com')) return json({ tag_name: 'v0.3.1' });
          throw new Error('should not have downloaded');
        },
        out: out.write,
      });
      expect(code).toBe(0);
      expect(out.text()).toContain('nothing was changed');
      expect(await readFile(target, 'utf8')).toBe('old binary');
    });
  });

  test('renames the running image aside on Windows rather than overwriting it', async () => {
    const order: string[] = [];
    const removed: string[] = [];
    await replace('C:\\bin\\.tmp', 'C:\\bin\\earshot.exe', 'win32', {
      rename: async (from, to) => void order.push(`${from} -> ${to}`),
      // A running .exe cannot be deleted; the real call fails exactly here.
      remove: async (path) => {
        removed.push(path);
        throw new Error('EBUSY');
      },
    });
    expect(order).toEqual([
      `C:\\bin\\earshot.exe -> C:\\bin\\earshot.exe.old-${process.pid}`,
      'C:\\bin\\.tmp -> C:\\bin\\earshot.exe',
    ]);
    // The undeletable old image is swallowed, not surfaced as a failed update.
    expect(removed).toHaveLength(1);
  });

  test('rolls the Windows rename back when the replacement rename fails', async () => {
    const order: string[] = [];
    const attempt = replace('C:\\bin\\.tmp', 'C:\\bin\\earshot.exe', 'win32', {
      rename: async (from, to) => {
        order.push(`${from} -> ${to}`);
        if (from.endsWith('.tmp')) throw new Error('EPERM');
      },
      remove: async () => {},
    });
    expect(attempt).rejects.toThrow('EPERM');
    await attempt.catch(() => {});
    expect(order.at(-1)).toBe(`C:\\bin\\earshot.exe.old-${process.pid} -> C:\\bin\\earshot.exe`);
  });

  test('a network failure is exit 1, not a crash', async () => {
    const err = capture();
    const code = await runUpdate({
      install: { kind: 'npm', path: '/n', manager: 'npm', local: false },
      current: '0.2.0',
      fetch: async () => new Response('', { status: 503 }),
      out: () => {},
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('503');
  });
});
