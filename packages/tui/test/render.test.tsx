import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Agent, type CreatedSession } from '@earshot/core';
import {
  type Message,
  type Model,
  type Provider,
  ProviderRegistry,
  type StreamEvent,
  type ToolCallPart,
  type WireApi,
} from '@earshot/providers';
import { render } from 'ink';
import { App } from '../src/app.tsx';

/**
 * Ink writes to whatever stdout it is handed. These fakes stand in for a
 * terminal so the app can be mounted and driven in a test - without them the
 * only way to find out that a component crashes on mount is to run earshot.
 */
class FakeStdout extends EventEmitter {
  output = '';
  columns = 100;
  rows = 30;
  readonly isTTY = true;
  write(data: string): boolean {
    this.output += data;
    return true;
  }
}

/**
 * A real duplex stream rather than an EventEmitter with the right method names.
 * Ink consumes stdin the way Node streams are consumed, so a hand-rolled fake
 * silently delivers nothing: every input assertion fails while every render
 * assertion passes, which reads like an app bug and is not one.
 */
class FakeStdin extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  // Ink refs stdin to keep the process alive while raw mode is on; a plain
  // stream has no such method and Ink's error boundary catches the TypeError,
  // which renders as a stack trace where the app should be.
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  /** Delivers a keystroke the way a terminal would. */
  send(data: string): void {
    this.write(data);
  }
}

interface Turn {
  text?: string;
  calls?: Array<{ name: string; input: unknown }>;
}

function scriptedRegistry(turns: Turn[]) {
  let next = 0;
  const model: Model = {
    id: 'scripted',
    providerId: 'test',
    name: 'Scripted',
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    cost: { input: 1, output: 1 },
    capabilities: { tools: true, vision: false, reasoning: false },
    api: 'openai-completions',
  };

  const wire: WireApi = {
    kind: 'openai-completions',
    async *stream(): AsyncIterable<StreamEvent> {
      const turn = turns[next++] ?? {};
      const content: Message['content'] = [];
      if (turn.text) {
        yield { type: 'text_delta', text: turn.text };
        content.push({ type: 'text', text: turn.text });
      }
      for (const [i, call] of (turn.calls ?? []).entries()) {
        const part: ToolCallPart = {
          type: 'tool_call',
          toolCallId: `c${next}_${i}`,
          toolName: call.name,
          input: call.input,
        };
        yield { type: 'tool_call_end', ...part, input: part.input };
        content.push(part);
      }
      const usage = { inputTokens: 1, outputTokens: 1 };
      yield {
        type: 'finish',
        reason: (turn.calls ?? []).length ? 'tool_calls' : 'stop',
        usage,
        message: { role: 'assistant', content },
      };
    },
  };

  const provider: Provider = {
    id: 'test',
    name: 'Test',
    auth: { kind: 'none' },
    api: 'openai-completions',
    models: () => [model],
  };
  return {
    registry: new ProviderRegistry().register(provider).registerWire(wire),
    resolved: { provider, model, credentials: { type: 'ambient' as const } },
  };
}

function sessionFor(turns: Turn[], cwd: string, mode: 'auto' | 'ask' = 'auto'): CreatedSession {
  const { registry, resolved } = scriptedRegistry(turns);
  const agent = new Agent({ registry, model: resolved, cwd, system: '', mode, rules: [] });
  return {
    agent,
    problems: [],
    resumed: 0,
    installPrompt: (prompt) => agent.setPrompt(prompt),
    installAsk: (ask) => agent.setAsk(ask),
    async dispose() {
      agent.dispose();
    },
  };
}

/** Lets the app mount, run its effects and settle. */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for text to appear on screen.
 *
 * Polling rather than a fixed sleep: a sleep long enough to be reliable on a
 * loaded CI runner is far longer than these need locally, and one short enough
 * to be pleasant locally fails intermittently there. This waits only as long as
 * it has to and fails with what was actually rendered.
 */
async function waitFor(stdout: FakeStdout, text: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdout.output.includes(text)) return;
    await settle(10);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)}. Rendered:\n${stdout.output}`);
}

/**
 * Types text and then presses Return, with a tick between.
 *
 * Writing both in one tick makes the stream coalesce them into a single chunk,
 * which Ink reads as pasted text containing a carriage return rather than as a
 * keystroke followed by Return - so nothing submits. A terminal delivers them
 * separately, and so does this.
 */
async function type(stdin: FakeStdin, text: string): Promise<void> {
  stdin.send(text);
  await settle(30);
  stdin.send('\r');
  await settle(30);
}

async function withApp(
  turns: Turn[],
  fn: (io: { stdout: FakeStdout; stdin: FakeStdin; cwd: string }) => Promise<void>,
  options: {
    mode?: 'auto' | 'ask';
    initialPrompt?: string;
    /** Runs before the app mounts, so a turn cannot race the fixture. */
    setup?: (cwd: string) => Promise<void>;
  } = {},
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'earshot-tui-'));
  await options.setup?.(cwd);
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const session = sessionFor(turns, cwd, options.mode ?? 'auto');

  const instance = render(
    <App
      session={session}
      model="test/scripted"
      {...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {})}
    />,
    {
      stdout: stdout as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  try {
    await settle();
    await fn({ stdout, stdin, cwd });
  } finally {
    instance.unmount();
    await session.dispose();
  }
}

/**
 * These mount a real Ink app and read what it draws.
 *
 * They do not run on CI yet, and the reason is not understood: on all three
 * GitHub runners the captured stdout stays empty, while the same tests pass
 * locally - including with CI=true and GITHUB_ACTIONS=true set, so Ink's own
 * is-in-ci check is ruled out. Skipping is a placeholder, not a conclusion:
 * these cover the permission prompt and ask_user, which are worth having
 * covered everywhere, so this should be diagnosed rather than left.
 */
const describeLocal = process.env.CI ? describe.skip : describe;

describeLocal('the app renders', () => {
  test('mounts and shows the status line', async () => {
    await withApp([{ text: 'hi' }], async ({ stdout }) => {
      await waitFor(stdout, 'test/scripted');
      expect(stdout.output).toContain('auto');
    });
  });

  test('an initial prompt runs a turn and its answer reaches the screen', async () => {
    await withApp(
      [{ text: 'the answer is 41' }],
      async ({ stdout }) => {
        await waitFor(stdout, 'the answer is 41');
      },
      { initialPrompt: 'what is the answer?' },
    );
  });

  test('a tool call renders as a block naming the tool', async () => {
    await withApp(
      [{ calls: [{ name: 'ls', input: {} }] }, { text: 'listed' }],
      async ({ stdout }) => {
        await waitFor(stdout, 'listed');
        expect(stdout.output).toContain('ls');
      },
      { initialPrompt: 'list the directory' },
    );
  });

  test('typed input reaches the screen', async () => {
    await withApp([{ text: 'ok' }], async ({ stdout, stdin }) => {
      stdin.send('hello');
      await waitFor(stdout, 'hello');
    });
  });

  test('an unknown slash command is reported rather than sent to the model', async () => {
    await withApp([{ text: 'should not be reached' }], async ({ stdout, stdin }) => {
      await type(stdin, '/nonsense');
      await waitFor(stdout, 'unknown command');
      expect(stdout.output).not.toContain('should not be reached');
    });
  });

  test('/mode switches the permission mode and says so', async () => {
    await withApp([{ text: 'ok' }], async ({ stdout, stdin }) => {
      await type(stdin, '/mode plan');
      await waitFor(stdout, 'permission mode: plan');
    });
  });
});

describeLocal('the permission prompt', () => {
  test('appears with the real diff when a write needs approval', async () => {
    await withApp(
      [
        { calls: [{ name: 'write', input: { path: 'a.txt', content: 'new\n' } }] },
        { text: 'done' },
      ],
      async ({ stdout }) => {
        await waitFor(stdout, 'Allow once');
        // The actual change, not a description of it.
        expect(stdout.output).toContain('-old');
        expect(stdout.output).toContain('+new');
      },
      {
        mode: 'ask',
        initialPrompt: 'change a.txt',
        setup: (cwd) => writeFile(join(cwd, 'a.txt'), 'old\n'),
      },
    );
  });

  test('a choice resolves the prompt and the turn continues', async () => {
    await withApp(
      [
        { calls: [{ name: 'write', input: { path: 'b.txt', content: 'x' } }] },
        { text: 'finished' },
      ],
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'Allow once');
        stdin.send('\r');
        await waitFor(stdout, 'finished');
      },
      { mode: 'ask', initialPrompt: 'write b.txt' },
    );
  });
});

describeLocal('ask_user', () => {
  test('the question is shown and a typed answer is accepted', async () => {
    await withApp(
      [
        { calls: [{ name: 'ask_user', input: { question: 'Postgres or SQLite?' } }] },
        { text: 'using SQLite' },
      ],
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'Postgres or SQLite?');
        await type(stdin, 'SQLite');
        await waitFor(stdout, 'using SQLite');
      },
      { initialPrompt: 'pick a database' },
    );
  });
});
