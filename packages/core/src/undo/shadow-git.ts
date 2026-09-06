import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '@earshot/providers';
import { projectKey } from '../session/store.ts';
import { exec, hasExecutable } from '../tools/exec.ts';
import { displayPath } from '../tools/fs-paths.ts';

/**
 * Per-batch snapshots of the files a turn is about to change, stored in a git
 * object database that lives outside the user's repository.
 *
 * The user's own repo is never touched: no commits, no stash, no index changes,
 * no reflog entries. An agent that commits to undo its own work is an agent that
 * has silently rewritten the user's history, and `git log` becomes unreadable.
 * `GIT_DIR` points at our own directory under the data dir instead, and the work
 * tree is the project, so `git hash-object` and `git cat-file` are all we need.
 *
 * Snapshots are of specific files, not of the whole tree: a turn touches a
 * handful of files and hashing the repository per batch would dominate the cost
 * of the batch itself.
 */
export interface Snapshot {
  id: string;
  timestamp: string;
  label: string;
  files: SnapshotFile[];
  /**
   * The session that took this snapshot.
   *
   * The store is keyed by working directory, so every session in a project
   * writes into the same one. Without this field `/undo` walked back through
   * whatever was most recent in the directory, which after a crash meant
   * reaching into a previous session's batches: a user who resumed and pressed
   * undo reverted work they had never seen this session do.
   *
   * Absent on snapshots written before this field existed. Those cannot be
   * attributed to any session, so they are unreachable rather than being
   * credited to the current one - crediting them would recreate exactly the
   * bug the field exists to close.
   */
  sessionId?: string;
}

export interface SnapshotFile {
  /** Absolute path in the work tree. */
  path: string;
  /** Blob hash of the contents before the batch, or null when it did not exist. */
  before: string | null;
}

/**
 * Blobs are round-tripped as UTF-8 text, which is what every tool in this harness
 * writes. A binary file edited by a shell command would not survive a restore, so
 * snapshots are taken of the paths the file tools declare, not of arbitrary ones.
 */
const MAX_RESTORE_BYTES = 64 * 1024 * 1024;

export function shadowDir(cwd: string): string {
  return join(dataDir(), 'undo', projectKey(cwd));
}

export class ShadowGit {
  private constructor(
    readonly gitDir: string,
    readonly cwd: string,
    /** Stamped onto new snapshots and used to filter `list()`. */
    readonly sessionId?: string,
  ) {}

  /**
   * Returns `undefined` when git is not installed rather than throwing: undo is
   * a convenience, and an agent that refuses to edit files because it cannot
   * snapshot them is worse than one that edits without an undo history. Callers
   * treat a missing store as "no snapshots available".
   */
  static async open(cwd: string, sessionId?: string): Promise<ShadowGit | undefined> {
    if (!(await hasExecutable('git', cwd))) return undefined;

    const gitDir = shadowDir(cwd);
    const initialised = await stat(join(gitDir, 'HEAD')).catch(() => undefined);
    if (!initialised) {
      await mkdir(gitDir, { recursive: true });
      const result = await exec('git', ['init', '--bare', '--quiet', gitDir], { cwd });
      if (result.code !== 0) return undefined;
    }
    await mkdir(join(gitDir, 'snapshots'), { recursive: true });
    return new ShadowGit(gitDir, cwd, sessionId);
  }

  private run(args: string[], maxBytes?: number) {
    // GIT_DIR and GIT_WORK_TREE are set per invocation rather than by running
    // inside the shadow directory: the object store is bare and elsewhere, while
    // the files being hashed are in the project.
    return exec('git', args, {
      cwd: this.cwd,
      env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.cwd },
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
  }

  /**
   * Stores one file's current contents and returns its blob hash, or null when
   * the file does not exist yet - which is how a creation is recorded.
   */
  async hashFile(path: string): Promise<string | null> {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return null;
    const result = await this.run(['hash-object', '-w', '--', path]);
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  }

  /**
   * Snapshots the given paths as they are now, before a batch modifies them.
   * Must be called before the tools run, which is why the loop hands it the
   * `writes` from each permission request rather than discovering paths after.
   */
  async snapshot(paths: string[], label: string): Promise<Snapshot | undefined> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return undefined;

    const files: SnapshotFile[] = [];
    for (const path of unique) files.push({ path, before: await this.hashFile(path) });
    return this.record(files, label);
  }

  /**
   * Writes a snapshot record from hashes captured earlier. The loop hashes each
   * file immediately before the tool that changes it, then records the batch as
   * one unit at the end, so undo restores a whole batch rather than half of one.
   */
  async record(files: SnapshotFile[], label: string): Promise<Snapshot | undefined> {
    if (files.length === 0) return undefined;

    const snapshot: Snapshot = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      label,
      files,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
    };
    await writeFile(
      join(this.gitDir, 'snapshots', `${snapshot.id}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8',
    );
    return snapshot;
  }

  /**
   * Snapshots this session may undo, oldest first.
   *
   * Scoped rather than unscoped by default, so the safe reading is the one a
   * caller gets without asking. A store opened without a session id sees
   * nothing: it cannot tell its own batches from another session's, and
   * guessing is what produced the bug.
   */
  async list(): Promise<Snapshot[]> {
    const all = await this.listAll();
    if (this.sessionId === undefined) return [];
    return all.filter((snapshot) => snapshot.sessionId === this.sessionId);
  }

  /** Every snapshot in the directory, whichever session wrote it. */
  async listAll(): Promise<Snapshot[]> {
    const dir = join(this.gitDir, 'snapshots');
    const names = await readdir(dir).catch(() => []);
    const snapshots: Snapshot[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = await readFile(join(dir, name), 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      try {
        snapshots.push(JSON.parse(raw) as Snapshot);
      } catch {
        // A snapshot written during a crash; the rest are still usable.
      }
    }
    return snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Reads a stored blob back. The output cap is raised well above the default,
   * which exists to stop a runaway tool from filling the context window - here it
   * would silently truncate the file being restored, which is data loss.
   */
  async contents(hash: string): Promise<string | undefined> {
    const result = await this.run(['cat-file', 'blob', hash], MAX_RESTORE_BYTES);
    return result.code === 0 ? result.stdout : undefined;
  }

  /**
   * Restores every file in a snapshot to its recorded contents. A file the batch
   * created is left in place rather than deleted - removing a path on the user's
   * behalf is not something an undo should do silently - and comes back in
   * `wasCreated` so the caller can say which files it did not touch.
   */
  async restore(snapshot: Snapshot): Promise<{ restored: string[]; wasCreated: string[] }> {
    const restored: string[] = [];
    const wasCreated: string[] = [];

    for (const file of snapshot.files) {
      if (file.before === null) {
        wasCreated.push(displayPath(this.cwd, file.path));
        continue;
      }
      const content = await this.contents(file.before);
      if (content === undefined) continue;
      await writeFile(file.path, content, 'utf8');
      restored.push(displayPath(this.cwd, file.path));
    }
    return { restored, wasCreated };
  }
}
