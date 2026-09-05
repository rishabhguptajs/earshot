import { describe, expect, test } from 'bun:test';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '@earshot/providers';
import { createSession } from '../src/session/create.ts';
import { repairMessage, unresolvedToolCalls } from '../src/session/repair.ts';
import { branchTo, messagesOf, readEntries, SessionStore } from '../src/session/store.ts';
import { withTempDir } from './helpers.ts';
import { scripted } from './scripted-model.ts';

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

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

const callsFor = (...names: string[]): Message => ({
  role: 'assistant',
  content: names.map((name, index) => ({
    type: 'tool_call' as const,
    toolCallId: `call-${index}`,
    toolName: name,
    input: {},
  })),
});

const resultFor = (id: string): Message => ({
  role: 'tool',
  content: [
    {
      type: 'tool_result',
      toolCallId: id,
      toolName: 'read',
      output: { type: 'text', value: 'ok' },
    },
  ],
});

const meta = { model: 'test/scripted', version: '0.0.1' };

describe('finding calls a crash left unanswered', () => {
  test('a call answered later in the branch is not unresolved', () => {
    const messages = [user('go'), callsFor('read'), resultFor('call-0')];
    expect(unresolvedToolCalls(messages)).toEqual([]);
  });

  test('a call with no result anywhere in the branch is reported', () => {
    const orphans = unresolvedToolCalls([user('go'), callsFor('read', 'edit')]);
    expect(orphans.map((call) => call.toolName)).toEqual(['read', 'edit']);
  });

  test('only the unanswered half of a partially answered batch is reported', () => {
    const orphans = unresolvedToolCalls([
      user('go'),
      callsFor('read', 'edit'),
      resultFor('call-0'),
    ]);
    expect(orphans.map((call) => call.toolCallId)).toEqual(['call-1']);
  });

  test('the repair answers every call, in the order they were emitted', () => {
    const repair = repairMessage(unresolvedToolCalls([callsFor('read', 'edit')]));
    expect(repair.role).toBe('tool');
    expect(repair.content.map((part) => (part as { toolCallId: string }).toolCallId)).toEqual([
      'call-0',
      'call-1',
    ]);
    // It says the outcome is unknown rather than that the call failed: a process
    // killed after a write completed still wrote the file, and a repair claiming
    // otherwise would be a lie the model then acts on.
    expect(repair.content.every((part) => (part as { isError?: boolean }).isError)).toBe(true);
    expect((repair.content[0] as { output: { value: string } }).output.value).toContain('unknown');
  });
});

describe('resuming a session a crash interrupted', () => {
  test('a torn final line costs that entry and nothing before it', async () => {
    await inSandbox(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.appendMessage(user('survives'));
      await store.flush();
      // How a kill mid-write actually lands: a complete prefix, no newline.
      await appendFile(store.path, '{"type":"message","id":"tor');

      const model = scripted([{ text: 'ok' }]);
      const session = await createSession({
        cwd,
        model: 'test/scripted',
        registry: model.registry,
        resume: { path: store.path },
      });
      expect(session.resumed).toBe(1);
      expect(session.agent.history.map((message) => message.role)).toEqual(['user']);
      await session.dispose();
    });
  });

  test('a tool call left without a result is answered by an appended entry', async () => {
    await inSandbox(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.appendMessage(user('change a.txt'));
      // The crash window: the calls reached disk, the results never did.
      await store.appendMessage(callsFor('read', 'edit'));
      await store.flush();
      const before = (await readEntries(store.path)).length;

      const model = scripted([{ text: 'ok' }]);
      const session = await createSession({
        cwd,
        model: 'test/scripted',
        registry: model.registry,
        resume: { path: store.path },
      });

      expect(session.agent.history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
      ]);
      expect(unresolvedToolCalls(session.agent.history)).toEqual([]);
      expect(session.problems.join('\n')).toContain('repaired an interrupted turn');
      expect(session.problems.join('\n')).toContain('read, edit');
      await session.dispose();

      // Appended, never rewritten: the original entries are still there, and the
      // repair is one more entry chained onto them.
      const entries = await readEntries(store.path);
      expect(entries).toHaveLength(before + 1);
      expect(entries.at(-1)?.parentId).toBe(entries.at(-2)?.id as string);
    });
  });

  test('resuming a repaired session twice does not repair it again', async () => {
    await inSandbox(async (cwd) => {
      const store = await SessionStore.create(cwd, meta);
      await store.appendMessage(user('go'));
      await store.appendMessage(callsFor('read'));
      await store.flush();

      const open = async () => {
        const model = scripted([{ text: 'ok' }]);
        const session = await createSession({
          cwd,
          model: 'test/scripted',
          registry: model.registry,
          resume: { path: store.path },
        });
        await session.dispose();
        return session;
      };
      await open();
      const second = await open();

      expect(second.problems.join('\n')).not.toContain('repaired an interrupted turn');
      const roles = messagesOf(branchTo(await readEntries(store.path))).map(
        (message) => message.role,
      );
      expect(roles).toEqual(['user', 'assistant', 'tool']);
    });
  });
});
