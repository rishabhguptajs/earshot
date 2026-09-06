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
      const shadow = await ShadowGit.open(cwd, 'session-under-test');
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
      // With a session id, or the empty list below would be the scoping rule
      // rather than the absence of a snapshot, and the test would pass whatever
      // the loop did.
      const shadow = await ShadowGit.open(cwd, 'session-under-test');
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

/**
 * Which snapshots a session may undo.
 *
 * The store is keyed by working directory, so every session in a project shares
 * it. Undo was ordered by timestamp across the whole directory, which meant a
 * user who crashed, resumed, and pressed undo reverted a batch from a session
 * they had never watched run.
 */
describe('undo scope', () => {
  test('a snapshot from another session is not offered to this one', async () => {
    await inDataDir(async (cwd) => {
      const theirs = await ShadowGit.open(cwd, 'their-session');
      const mine = await ShadowGit.open(cwd, 'my-session');
      if (!theirs || !mine) return;

      const path = join(cwd, 'a.txt');
      await writeFile(path, 'theirs\n');
      await theirs.snapshot([path], 'their batch');
      await writeFile(path, 'mine\n');
      await mine.snapshot([path], 'my batch');

      expect((await mine.list()).map((snapshot) => snapshot.label)).toEqual(['my batch']);
      expect((await theirs.list()).map((snapshot) => snapshot.label)).toEqual(['their batch']);
      // Both are still on disk: this is a visibility rule, not a deletion.
      expect(await mine.listAll()).toHaveLength(2);
    });
  });

  test('a snapshot with no session recorded belongs to none of them', async () => {
    await inDataDir(async (cwd) => {
      const legacy = await ShadowGit.open(cwd);
      const mine = await ShadowGit.open(cwd, 'my-session');
      if (!legacy || !mine) return;

      const path = join(cwd, 'a.txt');
      await writeFile(path, 'before\n');
      await legacy.snapshot([path], 'written before sessions were recorded');

      // Crediting it to whoever asks would restore the very bug this closes.
      expect(await mine.list()).toEqual([]);
      expect(await mine.listAll()).toHaveLength(1);
    });
  });

  test('a store opened without a session sees nothing to undo', async () => {
    await inDataDir(async (cwd) => {
      const scoped = await ShadowGit.open(cwd, 'my-session');
      const unscoped = await ShadowGit.open(cwd);
      if (!scoped || !unscoped) return;

      const path = join(cwd, 'a.txt');
      await writeFile(path, 'before\n');
      await scoped.snapshot([path], 'my batch');

      // It cannot tell its own batches from anyone else's, so it claims none.
      expect(await unscoped.list()).toEqual([]);
    });
  });
});
