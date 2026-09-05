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
