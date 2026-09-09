import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSession, NoSessionToResumeError } from '../src/session/create.ts';
import { branchTo, messagesOf, readEntries } from '../src/session/store.ts';
import { withTempDir } from './helpers.ts';
import { scripted } from './scripted-model.ts';

/**
 * End-to-end through `createSession`: settings, the loop, the transcript and undo
 * together. The model is scripted, so what is under test is the wiring - every
 * other test here exercises one layer in isolation, and this is the one that
 * would catch two of them being connected wrongly.
 */
async function inSandbox<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const previous = {
      data: process.env.EARSHOT_DATA_DIR,
      config: process.env.EARSHOT_CONFIG_DIR,
    };
    process.env.EARSHOT_DATA_DIR = join(dir, 'data');
    process.env.EARSHOT_CONFIG_DIR = join(dir, 'config');
    const cwd = join(dir, 'project');
    await mkdir(cwd, { recursive: true });
    try {
      return await fn(cwd);
    } finally {
      restore('EARSHOT_DATA_DIR', previous.data);
      restore('EARSHOT_CONFIG_DIR', previous.config);
    }
  });
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const signal = () => new AbortController().signal;

async function drain(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of generator) {
    // events are asserted through their effects
  }
}

describe('a session end to end', () => {
  test('edits land on disk and the transcript records the whole exchange', async () => {
    await inSandbox(async (cwd) => {
      await writeFile(join(cwd, 'a.txt'), 'before\n');
      const model = scripted([
        { calls: [{ name: 'read', input: { path: 'a.txt' } }] },
        {
          text: 'replacing it',
          calls: [{ name: 'edit', input: { path: 'a.txt', find: 'before', replace: 'after' } }],
        },
        { text: 'done' },
      ]);

      const session = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: model.registry,
      });
      await drain(session.agent.runTurn('change a.txt', signal()));
      await session.dispose();

      expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('after\n');

      const entries = await readEntries((session.store as { path: string }).path);
      const roles = messagesOf(branchTo(entries)).map((message) => message.role);
      // The trailing user/assistant pair is the end-of-turn self-check: the turn
      // changed a file, so the harness put the verification result in front of
      // the model before it was allowed to report.
      expect(roles).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
        'tool',
        'assistant',
        'user',
        'assistant',
      ]);
    });
  });

  test('rewinding drops later messages from the next request but not from the file', async () => {
    await inSandbox(async (cwd) => {
      const model = scripted([{ text: 'first' }, { text: 'second' }, { text: 'third' }]);
      const session = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: model.registry,
      });

      await drain(session.agent.runTurn('one', signal()));
      await drain(session.agent.runTurn('two', signal()));
      const before = await readEntries((session.store as { path: string }).path);

      const kept = await session.rewindTo(
        (await session.branch()).find(
          (entry) => entry.type === 'message' && entry.message.role === 'assistant',
        )?.id as string,
      );
      expect(kept).toBe(2);
      expect(session.agent.history).toHaveLength(2);

      // Nothing was removed: the abandoned branch is still on disk.
      const after = await readEntries((session.store as { path: string }).path);
      expect(after.length).toBeGreaterThanOrEqual(before.length);

      await drain(session.agent.runTurn('three', signal()));
      await session.dispose();

      // The new turn hangs off the rewound entry, so the branch skips "two".
      const branch = messagesOf(
        branchTo(await readEntries((session.store as { path: string }).path)),
      );
      const texts = branch.flatMap((message) =>
        message.content.filter((part) => part.type === 'text').map((part) => part.text),
      );
      expect(texts).toContain('three');
      expect(texts).not.toContain('two');
    });
  });

  test('forking continues in a new transcript that records where it came from', async () => {
    await inSandbox(async (cwd) => {
      const model = scripted([{ text: 'first' }, { text: 'second' }]);
      const session = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: model.registry,
      });
      await drain(session.agent.runTurn('one', signal()));
      const original = (session.store as { path: string }).path;

      const forked = await session.fork();
      expect(forked).toBeDefined();

      await drain(session.agent.runTurn('two', signal()));
      await session.dispose();

      // The original is untouched by anything that happened after the fork.
      const originalTexts = JSON.stringify(messagesOf(branchTo(await readEntries(original))));
      expect(originalTexts).not.toContain('two');
    });
  });

  test('undo steps back one batch at a time', async () => {
    await inSandbox(async (cwd) => {
      await writeFile(join(cwd, 'a.txt'), 'original\n');
      const model = scripted([
        { calls: [{ name: 'write', input: { path: 'a.txt', content: 'first\n' } }] },
        { text: 'done' },
        { calls: [{ name: 'write', input: { path: 'a.txt', content: 'second\n' } }] },
        { text: 'done' },
      ]);
      const session = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: model.registry,
      });

      await drain(session.agent.runTurn('write it', signal()));
      await drain(session.agent.runTurn('write it again', signal()));
      expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('second\n');

      await session.undo();
      expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('first\n');

      // A second undo goes back another batch rather than repeating the first.
      await session.undo();
      expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('original\n');
      await session.dispose();
    });
  });

  test('a new session does not undo the previous one’s batches', async () => {
    await inSandbox(async (cwd) => {
      await writeFile(join(cwd, 'a.txt'), 'original\n');
      const first = scripted([
        { calls: [{ name: 'write', input: { path: 'a.txt', content: 'theirs\n' } }] },
        { text: 'done' },
      ]);
      const earlier = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: first.registry,
      });
      await drain(earlier.agent.runTurn('write it', signal()));
      await earlier.dispose();

      // What a crash leaves behind: a finished batch in the directory's store,
      // belonging to a session the next one never watched run.
      const second = scripted([{ text: 'nothing to do' }]);
      const later = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: second.registry,
      });

      expect(await later.undo()).toBeUndefined();
      expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('theirs\n');
      await later.dispose();
    });
  });

  test('resuming replays the previous transcript into the new turn', async () => {
    await inSandbox(async (cwd) => {
      const first = scripted([{ text: 'noted' }]);
      const opened = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: first.registry,
      });
      await drain(opened.agent.runTurn('remember the number 41', signal()));
      await opened.dispose();

      const second = scripted([{ text: 'it was 41' }]);
      const resumed = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: second.registry,
        resume: { latest: true },
      });
      expect(resumed.resumed).toBe(2);

      await drain(resumed.agent.runTurn('what was the number?', signal()));
      await resumed.dispose();

      const sent = second.requests[0]?.messages ?? [];
      const texts = sent.flatMap((message) =>
        message.content.filter((part) => part.type === 'text').map((part) => part.text),
      );
      expect(texts).toContain('remember the number 41');
      expect(texts).toContain('what was the number?');
    });
  });

  test('resuming continues the same transcript rather than duplicating it', async () => {
    await inSandbox(async (cwd) => {
      const first = scripted([{ text: 'one' }]);
      const opened = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: first.registry,
      });
      await drain(opened.agent.runTurn('first', signal()));
      await opened.dispose();
      const path = (opened.store as { path: string }).path;
      const before = (await readEntries(path)).length;

      const second = scripted([{ text: 'two' }]);
      const resumed = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: second.registry,
        resume: { latest: true },
      });
      await drain(resumed.agent.runTurn('second', signal()));
      await resumed.dispose();

      // Two new entries, not the replayed history written back a second time.
      expect((await readEntries(path)).length).toBe(before + 2);
      expect((resumed.store as { path: string }).path).toBe(path);
    });
  });

  test('resuming with no previous session says so rather than starting a blank one', async () => {
    await inSandbox(async (cwd) => {
      const model = scripted([{ text: 'hi' }]);
      const failure = createSession({
        cwd,
        model: 'test/scripted',
        registry: model.registry,
        resume: { latest: true },
      });
      await expect(failure).rejects.toThrow(NoSessionToResumeError);
    });
  });

  test('project settings are honoured without being passed as flags', async () => {
    await inSandbox(async (cwd) => {
      await mkdir(join(cwd, '.earshot'), { recursive: true });
      await writeFile(
        join(cwd, '.earshot/settings.json'),
        JSON.stringify({ permissions: { deny: ['Write(*)'], defaultMode: 'auto' } }),
      );

      const model = scripted([
        { calls: [{ name: 'write', input: { path: 'blocked.txt', content: 'x' } }] },
        { text: 'blocked' },
      ]);
      const session = await createSession({
        cwd,
        model: 'test/scripted',
        registry: model.registry,
      });
      expect(session.agent.permissionMode).toBe('auto');

      await drain(session.agent.runTurn('write a file', signal()));
      await session.dispose();

      expect(
        await readFile(join(cwd, 'blocked.txt'), 'utf8').catch(() => undefined),
      ).toBeUndefined();
    });
  });

  test('AGENTS.md reaches the system prompt the model is actually sent', async () => {
    await inSandbox(async (cwd) => {
      await mkdir(join(cwd, '.git'), { recursive: true });
      await writeFile(join(cwd, 'AGENTS.md'), 'Always write British English.');

      const model = scripted([{ text: 'understood' }]);
      const session = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: model.registry,
      });
      await drain(session.agent.runTurn('hello', signal()));
      await session.dispose();

      expect(model.requests[0]?.system).toContain('Always write British English.');
    });
  });
});

/**
 * The catalog decides whether a model reasons, and it is a vendored snapshot of
 * someone else's data. When it is wrong the user is stuck: earshot sends a
 * reasoning parameter the provider rejects, on every turn, with no way to stop
 * it. `thinking` in settings overrides it in both directions.
 */
describe('the thinking override', () => {
  const settings = (cwd: string, value: unknown) =>
    mkdir(join(cwd, '.earshot'), { recursive: true }).then(() =>
      writeFile(join(cwd, '.earshot/settings.json'), JSON.stringify(value)),
    );

  test('forces reasoning on a model the catalog says cannot reason', async () => {
    await inSandbox(async (cwd) => {
      await settings(cwd, { thinking: { 'test/scripted': true } });
      const model = scripted([{ text: 'ok' }]);

      const session = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: model.registry,
      });
      await drain(session.agent.runTurn('hi', signal()));
      await session.dispose();

      expect(model.requests[0]?.reasoningEffort).toBe('medium');
    });
  });

  test('sends no reasoning parameter at all when turned off', async () => {
    await inSandbox(async (cwd) => {
      await settings(cwd, {
        thinking: { 'test/scripted': false },
        reasoningEfforts: { 'test/scripted': 'high' },
      });
      const model = scripted([{ text: 'ok' }]);
      // The catalog claiming the model reasons is exactly the case that breaks:
      // without the override, `high` would be sent to a provider that rejects it.
      model.model.model.capabilities.reasoning = true;

      const session = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: model.registry,
      });
      await drain(session.agent.runTurn('hi', signal()));
      await session.dispose();

      expect(model.requests[0]?.reasoningEffort).toBeUndefined();
    });
  });

  test('without an override the catalog still decides', async () => {
    await inSandbox(async (cwd) => {
      await settings(cwd, { reasoningEfforts: { 'test/scripted': 'high' } });
      const model = scripted([{ text: 'ok' }]);

      const session = await createSession({
        cwd,
        model: 'test/scripted',
        mode: 'auto',
        registry: model.registry,
      });
      await drain(session.agent.runTurn('hi', signal()));
      await session.dispose();

      expect(model.requests[0]?.reasoningEffort).toBeUndefined();
    });
  });
});
