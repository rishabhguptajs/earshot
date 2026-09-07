import { describe, expect, test } from 'bun:test';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '@earshot/providers';
import {
  branchTo,
  latestConfiguration,
  latestSession,
  listSessions,
  messagesOf,
  readEntries,
  SessionStore,
} from '../src/session/store.ts';
import { withTempDir } from './helpers.ts';

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

/** Sessions live under the data dir; each test gets its own. */
async function inDataDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const previous = process.env.EARSHOT_DATA_DIR;
    process.env.EARSHOT_DATA_DIR = join(dir, 'data');
    try {
      return await fn(join(dir, 'project'));
    } finally {
      if (previous === undefined) delete process.env.EARSHOT_DATA_DIR;
      else process.env.EARSHOT_DATA_DIR = previous;
    }
  });
}

const meta = { model: 'test/scripted', version: '0.0.1' };

describe('the transcript', () => {
  test('model and reasoning changes are append-only and latest wins', async () => {
    await inDataDir(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.append({ type: 'configuration', model: 'test/other', reasoningEffort: 'high' });
      await store.append({ type: 'configuration', reasoningEffort: null });
      await store.flush();

      const entries = await readEntries(store.path);
      expect(entries.map((entry) => entry.type)).toEqual([
        'meta',
        'configuration',
        'configuration',
      ]);
      expect(latestConfiguration(entries)).toEqual({
        model: 'test/other',
        reasoningConfigured: true,
      });
      expect((await listSessions(cwd))[0]?.model).toBe('test/other');
    });
  });

  test('every entry is one line of JSON, in write order', async () => {
    await inDataDir(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.appendMessage(user('first'));
      await store.appendMessage(user('second'));
      await store.flush();

      const lines = (await readFile(store.path, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
        'meta',
        'message',
        'message',
      ]);
    });
  });

  test('each entry names the entry it follows, forming a chain', async () => {
    await inDataDir(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.appendMessage(user('a'));
      await store.appendMessage(user('b'));
      await store.flush();

      const entries = await readEntries(store.path);
      expect(entries[0]?.parentId).toBeNull();
      expect(entries[1]?.parentId).toBe(entries[0]?.id as string);
      expect(entries[2]?.parentId).toBe(entries[1]?.id as string);
    });
  });

  test('appending is serialised, so concurrent writes do not interleave', async () => {
    await inDataDir(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.appendMessage(user(`message ${i}`))),
      );
      await store.flush();

      const entries = await readEntries(store.path);
      expect(entries).toHaveLength(21);
      // A chain, not a set of siblings: each write saw the previous one's id.
      const ids = new Set(entries.map((entry) => entry.id));
      expect(ids.size).toBe(21);
      expect(branchTo(entries)).toHaveLength(21);
    });
  });

  test('a truncated final line does not lose the rest of the session', async () => {
    await inDataDir(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.appendMessage(user('survives'));
      await store.flush();
      await appendFile(store.path, '{"type":"message","id":"broke');

      const entries = await readEntries(store.path);
      expect(entries).toHaveLength(2);
      expect(messagesOf(entries)).toEqual([user('survives')]);
    });
  });
});

describe('branching', () => {
  test('a fork replays only its own branch, not the abandoned one', async () => {
    await inDataDir(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      const first = await store.appendMessage(user('shared'));
      await store.appendMessage(user('abandoned'));
      // Parented on `first` rather than on the entry just written: this is what a
      // rewind is, and it costs one append rather than a rewrite.
      await store.append({ type: 'message', message: user('taken') }, first);
      await store.flush();

      const entries = await readEntries(store.path);
      const texts = messagesOf(branchTo(entries)).map(
        (message) => (message.content[0] as { text: string }).text,
      );
      expect(texts).toEqual(['shared', 'taken']);
    });
  });

  test('a corrupt parent chain terminates instead of looping forever', () => {
    const entries = [
      { type: 'message', id: 'a', parentId: 'b', timestamp: '', message: user('a') },
      { type: 'message', id: 'b', parentId: 'a', timestamp: '', message: user('b') },
    ] as never;
    expect(branchTo(entries, 'a')).toHaveLength(2);
  });
});

describe('finding sessions', () => {
  test('sessions are grouped by working directory', async () => {
    await inDataDir(async (cwd) => {
      const other = `${cwd}-other`;
      await SessionStore.create(cwd, meta);
      await SessionStore.create(other, meta);

      expect(await listSessions(cwd)).toHaveLength(1);
      expect(await listSessions(other)).toHaveLength(1);
    });
  });

  test('the most recent session for this directory is the one --continue resumes', async () => {
    await inDataDir(async (cwd) => {
      const older = await SessionStore.create(cwd, meta);
      await older.appendMessage(user('older'));
      await older.flush();

      const newer = await SessionStore.create(cwd, meta);
      await newer.appendMessage(user('newer'));
      await newer.flush();

      const latest = await latestSession(cwd);
      expect(latest?.preview).toBe('newer');
    });
  });

  test('reopening a session appends to the end of it', async () => {
    await inDataDir(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.appendMessage(user('before'));
      await store.flush();

      const reopened = await SessionStore.open(store.path);
      await reopened.appendMessage(user('after'));
      await reopened.flush();

      const entries = await readEntries(store.path);
      expect(
        messagesOf(branchTo(entries)).map((m) => (m.content[0] as { text: string }).text),
      ).toEqual(['before', 'after']);
    });
  });

  test('a file that is not a transcript is skipped rather than breaking the list', async () => {
    await inDataDir(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.flush();
      await writeFile(join(store.path, '..', 'notes.txt'), 'not a session');
      expect(await listSessions(cwd)).toHaveLength(1);
    });
  });
});
