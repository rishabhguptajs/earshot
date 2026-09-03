import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '../src/agent.ts';
import { exec } from '../src/tools/exec.ts';
import { ShadowGit } from '../src/undo/shadow-git.ts';
import { withTempDir } from './helpers.ts';
import { scripted } from './scripted-model.ts';

/** Snapshots live under the data dir; each test gets its own. */
async function inDataDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const previous = process.env.EARSHOT_DATA_DIR;
    process.env.EARSHOT_DATA_DIR = join(dir, 'data');
    const cwd = join(dir, 'project');
    await mkdir(cwd, { recursive: true });
    try {
      return await fn(cwd);
    } finally {
      if (previous === undefined) delete process.env.EARSHOT_DATA_DIR;
      else process.env.EARSHOT_DATA_DIR = previous;
    }
  });
}

describe('the shadow object store', () => {
  test('restores a file to its contents before the batch', async () => {
    await inDataDir(async (cwd) => {
      const shadow = await ShadowGit.open(cwd);
      if (!shadow) return; // git is not installed on this machine
      const path = join(cwd, 'a.txt');
      await writeFile(path, 'original\n');

      const snapshot = await shadow.snapshot([path], 'edit');
      await writeFile(path, 'changed\n');
      expect(snapshot).toBeDefined();

      const report = await shadow.restore(snapshot as never);
      expect(await readFile(path, 'utf8')).toBe('original\n');
      expect(report.restored).toEqual(['a.txt']);
    });
  });

  test('a file the batch created is reported rather than deleted', async () => {
    await inDataDir(async (cwd) => {
      const shadow = await ShadowGit.open(cwd);
      if (!shadow) return;
      const path = join(cwd, 'new.txt');

      const snapshot = await shadow.snapshot([path], 'write');
      await writeFile(path, 'created by the agent\n');

      const report = await shadow.restore(snapshot as never);
      expect(report.wasCreated).toEqual(['new.txt']);
      expect(report.restored).toEqual([]);
      expect(await readFile(path, 'utf8')).toBe('created by the agent\n');
    });
  });

  test('nothing is written to the project repository', async () => {
    await inDataDir(async (cwd) => {
      const init = await exec('git', ['init', '--quiet'], { cwd });
      if (init.code !== 0) return;
      await writeFile(join(cwd, 'a.txt'), 'x\n');
      await exec('git', ['add', '.'], { cwd });

      const shadow = await ShadowGit.open(cwd);
      if (!shadow) return;
      await shadow.snapshot([join(cwd, 'a.txt')], 'edit');

      // No commits, and the index is exactly as the user left it.
      const log = await exec('git', ['log', '--oneline'], { cwd });
      expect(log.stdout.trim()).toBe('');
      const status = await exec('git', ['status', '--porcelain'], { cwd });
      expect(status.stdout).toContain('A  a.txt');
    });
  });

  test('a file larger than the default command-output cap round-trips intact', async () => {
    await inDataDir(async (cwd) => {
      const shadow = await ShadowGit.open(cwd);
      if (!shadow) return;
      const path = join(cwd, 'big.txt');
      // Comfortably past DEFAULT_MAX_OUTPUT_BYTES, which exists to protect the
      // context window and would silently truncate a restore if it applied here.
      const big = 'line of text\n'.repeat(20_000);
      await writeFile(path, big);

      const snapshot = await shadow.snapshot([path], 'edit');
      await writeFile(path, 'clobbered\n');
      await shadow.restore(snapshot as never);

      expect(await readFile(path, 'utf8')).toBe(big);
    });
  });
});

describe('snapshots taken by the loop', () => {
  test('one batch of edits is one undo step', async () => {
    await inDataDir(async (cwd) => {
      const shadow = await ShadowGit.open(cwd);
      if (!shadow) return;
      await writeFile(join(cwd, 'a.txt'), 'a before\n');
      await writeFile(join(cwd, 'b.txt'), 'b before\n');

      const model = scripted([
        {
          calls: [
            { name: 'write', input: { path: 'a.txt', content: 'a after\n' } },
            { name: 'write', input: { path: 'b.txt', content: 'b after\n' } },
          ],
        },
        { text: 'done' },
      ]);
      const agent = new Agent({
        registry: model.registry,
        model: model.model,
        cwd,
        system: '',
        mode: 'auto',
        rules: [],
        shadow,
      });
      for await (const _ of agent.runTurn('go', new AbortController().signal)) {
        // drain
      }

      const snapshots = await shadow.list();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.files).toHaveLength(2);

      await shadow.restore(snapshots[0] as never);
      expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('a before\n');
      expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('b before\n');
    });
  });

  test('a read-only batch records no snapshot', async () => {
    await inDataDir(async (cwd) => {
      const shadow = await ShadowGit.open(cwd);
      if (!shadow) return;
      const model = scripted([{ calls: [{ name: 'ls', input: {} }] }, { text: 'done' }]);
      const agent = new Agent({
        registry: model.registry,
        model: model.model,
        cwd,
        system: '',
        mode: 'auto',
        rules: [],
        shadow,
      });
      for await (const _ of agent.runTurn('go', new AbortController().signal)) {
        // drain
      }
      expect(await shadow.list()).toEqual([]);
    });
  });
});
