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
      expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
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
