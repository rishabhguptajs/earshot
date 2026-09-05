import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  branchTo,
  messagesOf,
  readEntries,
  SessionStore,
} from '../../../packages/core/src/index.ts';
import type { BenchCase } from '../runner.ts';

const ENTRIES = 2_000;

/**
 * The long-running-session surface. `--resume` reads the whole file, walks the
 * branch back to the root and rebuilds the message list before the first token
 * of the new turn, so this cost is paid up front and in full view of the user.
 */
export interface Suite {
  cases: BenchCase[];
  /** Runs once after every case in the suite, never per case. */
  cleanup: () => Promise<void>;
}

export async function sessionCases(): Promise<Suite> {
  // EARSHOT_DATA_DIR rather than the real data dir: a benchmark must not write
  // two thousand entries into somebody's actual session history.
  const root = await mkdtemp(join(tmpdir(), 'earshot-bench-'));
  const previousDataDir = process.env.EARSHOT_DATA_DIR;
  process.env.EARSHOT_DATA_DIR = root;

  const store = await SessionStore.create(root, { model: 'bench/model', version: '0.0.0-bench' });
  for (let i = 0; i < ENTRIES; i++) {
    store.appendMessage({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `entry ${i} ${'.'.repeat(200)}` }],
    });
  }
  await store.flush();
  const path = store.path;
  const leaf = store.tailId ?? undefined;
  const entries = await readEntries(path);

  const restore = async () => {
    if (previousDataDir === undefined) delete process.env.EARSHOT_DATA_DIR;
    else process.env.EARSHOT_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  };

  return {
    cleanup: restore,
    cases: [
      {
        name: 'session/read-entries',
        surface: 'session',
        what: `parse a ${ENTRIES}-entry transcript from disk`,
        iterations: 20,
        repeats: 5,
        run: () => readEntries(path),
      },
      {
        name: 'session/branch-to-leaf',
        surface: 'session',
        what: `walk ${ENTRIES} entries back to the root`,
        repeats: 20,
        run: () => branchTo(entries, leaf),
      },
      {
        name: 'session/messages-of',
        surface: 'session',
        what: `rebuild the message list from ${ENTRIES} entries`,
        repeats: 100,
        run: () => messagesOf(entries),
      },
      {
        name: 'session/resume',
        surface: 'session',
        // The three above in the order --resume actually performs them; measured
        // together because that sum is what the user waits for, and separately
        // because the sum does not say which of them grew.
        what: 'full --resume path: read, branch, rebuild',
        iterations: 20,
        repeats: 5,
        run: async () => messagesOf(branchTo(await readEntries(path), leaf)),
      },
    ],
  };
}
