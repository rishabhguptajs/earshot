import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../../core/test/helpers.ts';
import { runDoctor } from '../src/commands/doctor.ts';

describe('earshot doctor', () => {
  test('reports the runtime, shell, git, and writable state directories', async () => {
    await withTempDir(async (dir) => {
      const checks = await runDoctor({
        cwd: dir,
        env: { EARSHOT_CONFIG_DIR: join(dir, 'config'), EARSHOT_DATA_DIR: join(dir, 'data') },
        nodeVersion: '22.12.0',
        platform: 'linux',
        run: () => ({ status: 0, stdout: 'git version 2.47.0' }),
      });
      expect(checks.find((check) => check.name === 'runtime')?.status).toBe('pass');
      expect(checks.find((check) => check.name === 'shell')?.status).toBe('pass');
      expect(checks.find((check) => check.name === 'config directory')?.status).toBe('pass');
    });
  });

  test('fails on an old Node runtime and malformed settings', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '.earshot'));
      await writeFile(join(dir, '.earshot', 'settings.json'), '{nope');
      const checks = await runDoctor({
        cwd: dir,
        env: { EARSHOT_CONFIG_DIR: join(dir, 'config'), EARSHOT_DATA_DIR: join(dir, 'data') },
        nodeVersion: '20.0.0',
        platform: 'linux',
        run: () => ({ status: 1, stdout: '' }),
      });
      expect(checks.find((check) => check.name === 'runtime')?.status).toBe('fail');
      expect(checks.find((check) => check.name === 'project settings')?.status).toBe('fail');
      expect(checks.find((check) => check.name === 'git')?.status).toBe('warn');
    });
  });

  // The shell check reads the injected platform, so this reports the Windows
  // rule from any runner. Previously it read the host's, and the Linux test above
  // failed on the Windows runner by looking for a Git Bash that was not there.
  test('reports the Git Bash requirement when the host is Windows', async () => {
    await withTempDir(async (dir) => {
      const checks = await runDoctor({
        cwd: dir,
        env: {
          EARSHOT_CONFIG_DIR: join(dir, 'config'),
          EARSHOT_DATA_DIR: join(dir, 'data'),
          ProgramFiles: join(dir, 'nonexistent'),
        },
        nodeVersion: '22.12.0',
        platform: 'win32',
        run: () => ({ status: 0, stdout: 'git version 2.47.0' }),
      });
      const shell = checks.find((check) => check.name === 'shell');
      expect(shell?.status).toBe('fail');
      expect(shell?.detail).toContain('Git for Windows');
    });
  });

  test('passes the shell check on Windows when Git Bash is present', async () => {
    await withTempDir(async (dir) => {
      const bash = join(dir, 'bash.exe');
      await writeFile(bash, '');
      const checks = await runDoctor({
        cwd: dir,
        env: {
          EARSHOT_CONFIG_DIR: join(dir, 'config'),
          EARSHOT_DATA_DIR: join(dir, 'data'),
          EARSHOT_BASH: bash,
        },
        nodeVersion: '22.12.0',
        platform: 'win32',
        run: () => ({ status: 0, stdout: 'git version 2.47.0' }),
      });
      const shell = checks.find((check) => check.name === 'shell');
      expect(shell?.status).toBe('pass');
      expect(shell?.detail).toBe(bash);
    });
  });

  test('rejects an auth file readable by other users on POSIX', async () => {
    await withTempDir(async (dir) => {
      const config = join(dir, 'config');
      await mkdir(config);
      await writeFile(join(config, 'auth.json'), '{}');
      await chmod(join(config, 'auth.json'), 0o644);
      const checks = await runDoctor({
        cwd: dir,
        env: { EARSHOT_CONFIG_DIR: config, EARSHOT_DATA_DIR: join(dir, 'data') },
        platform: 'linux',
        run: () => ({ status: 0, stdout: 'git version 2' }),
      });
      expect(checks.find((check) => check.name === 'auth file')?.status).toBe('fail');
    });
  });
});
