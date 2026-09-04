import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
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

/**
 * Ink decides once, when its module is evaluated, whether it is running in CI -
 * and in CI it writes only <Static> output, never the live region. Every
 * assertion here reads the live region, so under CI the captured stdout stays
 * empty and every test times out. Clearing the variables before Ink is loaded
 * is why these imports are dynamic and why they must stay dynamic: a static
 * import is hoisted above the deletions and the suppression comes back.
 */
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
const { render } = await import('ink');
const { App } = await import('../src/app.tsx');

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

/** Entry ids the app asked to rewind to, so a test can assert it was reached. */
const rewound: string[] = [];

function sessionFor(turns: Turn[], cwd: string, mode: 'auto' | 'ask' = 'auto'): CreatedSession {
  const { registry, resolved } = scriptedRegistry(turns);
  const agent = new Agent({ registry, model: resolved, cwd, system: '', mode, rules: [] });
  return {
    agent,
    problems: [],
    resumed: 0,
    installPrompt: (prompt) => agent.setPrompt(prompt),
    installAsk: (ask) => agent.setAsk(ask),
    // The session-tree commands are wired to these; the storage layer has its
    // own tests, so what is under test here is that the commands reach them.
    branch: async () =>
      agent.history.map((message, index) => ({
        type: 'message' as const,
        id: `entry_${index}`,
        parentId: index === 0 ? null : `entry_${index - 1}`,
        timestamp: new Date().toISOString(),
        message,
      })),
    rewindTo: async (entryId: string) => {
      rewound.push(entryId);
      return 1;
    },
    fork: async () => 'forked-session',
    undo: async () => ({ label: 'write', restored: ['a.txt'], wasCreated: [] }),
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

describe('the app renders', () => {
  test('mounts and shows the status line', async () => {
    await withApp([{ text: 'hi' }], async ({ stdout }) => {
      await waitFor(stdout, 'test/scripted');
      expect(stdout.output).toContain('auto');
    });
  });

  test('the status line shows how much of the context window is in use', async () => {
    await withApp(
      [{ text: 'hi' }],
      async ({ stdout }) => {
        await waitFor(stdout, '% ctx');
      },
      { initialPrompt: 'hello' },
    );
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

describe('the permission prompt', () => {
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

describe('the session tree', () => {
  test('/tree lists the prompts of this session', async () => {
    await withApp(
      [{ text: 'answered' }],
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'answered');
        await type(stdin, '/tree');
        await waitFor(stdout, '1. the first thing');
        expect(stdout.output).toContain('/rewind');
      },
      { initialPrompt: 'the first thing' },
    );
  });

  test('/rewind goes back to the state before the chosen prompt', async () => {
    rewound.length = 0;
    await withApp(
      [{ text: 'answered' }],
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'answered');
        await type(stdin, '/rewind 1');
        await waitFor(stdout, 'rewound to before prompt 1');
        // Nothing is deleted; the user is told so, because that is what makes
        // rewinding safe to do on a hunch.
        expect(stdout.output).toContain('Nothing was deleted');
        expect(rewound).toHaveLength(1);
      },
      { initialPrompt: 'the first thing' },
    );
  });

  test('/rewind with no such prompt says so instead of guessing', async () => {
    await withApp([{ text: 'ok' }], async ({ stdout, stdin }) => {
      await type(stdin, '/rewind 9');
      await waitFor(stdout, 'no prompt 9');
    });
  });

  test('/undo reports what it restored', async () => {
    await withApp([{ text: 'ok' }], async ({ stdout, stdin }) => {
      await type(stdin, '/undo');
      await waitFor(stdout, 'undid write');
      expect(stdout.output).toContain('a.txt');
    });
  });
});

describe('remembering a preference', () => {
  test('a correction is offered as a memory rather than stored silently', async () => {
    await withApp([{ text: 'ok' }], async ({ stdout, stdin }) => {
      await type(stdin, 'always use bun, not npm');
      await waitFor(stdout, 'remember');
      expect(stdout.output).toContain('ctrl+r');
    });
  });

  test('an ordinary request offers nothing', async () => {
    await withApp([{ text: 'ok' }], async ({ stdout, stdin }) => {
      await type(stdin, 'add a retry to the fetch helper');
      await settle(60);
      expect(stdout.output).not.toContain('ctrl+r');
    });
  });

  test('taking the offer writes the memory and says where to review it', async () => {
    await withApp([{ text: 'ok' }], async ({ stdout, stdin, cwd }) => {
      await type(stdin, 'always use bun, not npm');
      await waitFor(stdout, 'remember');
      stdin.send('\x12'); // ctrl+r
      await waitFor(stdout, 'remembered');

      const files = await readdir(join(cwd, '.earshot', 'memories'));
      expect(files).toHaveLength(1);
      expect(stdout.output).toContain('/memory');
    });
  });

  test('/memory shows what the rule came from, and forgetting removes it', async () => {
    await withApp([{ text: 'ok' }], async ({ stdout, stdin, cwd }) => {
      await type(stdin, 'always use bun, not npm');
      await waitFor(stdout, 'remember');
      stdin.send('\x12');
      await waitFor(stdout, 'remembered');

      await type(stdin, '/memory');
      await waitFor(stdout, 'always use bun, not npm');

      const [file] = await readdir(join(cwd, '.earshot', 'memories'));
      await type(stdin, `/memory forget ${(file ?? '').replace(/\.md$/, '')}`);
      await waitFor(stdout, 'forgot');
      expect(await readdir(join(cwd, '.earshot', 'memories'))).toHaveLength(0);
    });
  });
});

describe('ask_user', () => {
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
