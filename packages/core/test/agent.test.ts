import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, type AgentEvent, type AgentOptions } from '../src/agent.ts';
import type { PromptChoice } from '../src/permissions/engine.ts';
import { parseRule } from '../src/permissions/rules.ts';
import { withTempDir } from './helpers.ts';
import { type ScriptedTurn, scripted } from './scripted-model.ts';

function agentFor(turns: ScriptedTurn[], cwd: string, overrides: Partial<AgentOptions> = {}) {
  const model = scripted(turns);
  const agent = new Agent({
    registry: model.registry,
    model: model.model,
    cwd,
    system: 'test system',
    mode: 'auto',
    rules: [],
    ...overrides,
  });
  return { agent, requests: model.requests };
}

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const signal = () => new AbortController().signal;

describe('the loop', () => {
  test('a turn with no tool calls ends after one model call', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor([{ text: 'done' }], dir);
      const events = await collect(agent.runTurn('hello', signal()));

      expect(requests).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'stop' });
      expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(1);
    });
  });

  test('a tool call is executed and its result fed back for another call', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'contents\n');
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'read', input: { path: 'a.txt' } }] }, { text: 'read it' }],
        dir,
      );
      await collect(agent.runTurn('read a.txt', signal()));

      expect(requests).toHaveLength(2);
      const second = requests[1]?.messages ?? [];
      const toolMessage = second.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      const part = toolMessage?.content[0];
      expect(part?.type).toBe('tool_result');
      if (part?.type === 'tool_result' && part.output.type === 'text') {
        expect(part.output.value).toContain('contents');
      }
    });
  });

  test('history is append-only: nothing already sent is rewritten', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'x\n');
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'read', input: { path: 'a.txt' } }] }, { text: 'ok' }],
        dir,
      );
      await collect(agent.runTurn('go', signal()));

      const first = requests[0]?.messages ?? [];
      const second = requests[1]?.messages ?? [];
      expect(second.length).toBeGreaterThan(first.length);
      expect(second.slice(0, first.length)).toEqual(first);
    });
  });

  test('every tool call gets a result, even one the loop could not run', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'no_such_tool', input: {} }] }, { text: 'ok' }],
        dir,
      );
      await collect(agent.runTurn('go', signal()));

      const toolMessage = (requests[1]?.messages ?? []).find((m) => m.role === 'tool');
      const part = toolMessage?.content[0];
      expect(part?.type).toBe('tool_result');
      if (part?.type === 'tool_result') {
        expect(part.isError).toBe(true);
        if (part.output.type === 'text') expect(part.output.value).toContain('no_such_tool');
      }
    });
  });

  test('results are ordered by the call order, not by which finished first', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'aaa\n');
      await writeFile(join(dir, 'b.txt'), 'bbb\n');
      const { agent, requests } = agentFor(
        [
          {
            calls: [
              { id: 'c1', name: 'read', input: { path: 'a.txt' } },
              { id: 'c2', name: 'ls', input: {} },
              { id: 'c3', name: 'read', input: { path: 'b.txt' } },
            ],
          },
          { text: 'ok' },
        ],
        dir,
      );
      await collect(agent.runTurn('go', signal()));

      const toolMessage = (requests[1]?.messages ?? []).find((m) => m.role === 'tool');
      const ids = (toolMessage?.content ?? []).map((part) =>
        part.type === 'tool_result' ? part.toolCallId : '',
      );
      expect(ids).toEqual(['c1', 'c2', 'c3']);
    });
  });

  test('a failing tool feeds the model an error result rather than crashing the turn', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'read', input: { path: 'missing.txt' } }] }, { text: 'ok' }],
        dir,
      );
      const events = await collect(agent.runTurn('go', signal()));

      expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'stop' });
      const toolMessage = (requests[1]?.messages ?? []).find((m) => m.role === 'tool');
      const part = toolMessage?.content[0];
      if (part?.type === 'tool_result') expect(part.isError).toBe(true);
    });
  });

  test('a runaway tool loop stops at maxSteps', async () => {
    await withTempDir(async (dir) => {
      const forever: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
        calls: [{ name: 'ls', input: {} }],
      }));
      const { agent } = agentFor(forever, dir, { maxSteps: 3 });
      const events = await collect(agent.runTurn('go', signal()));
      expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'max_steps' });
    });
  });
});

describe('steering', () => {
  test('a message typed mid-turn is injected at the next model call, not dropped', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'ls', input: {} }] }, { text: 'ok' }],
        dir,
      );

      const events: AgentEvent[] = [];
      for await (const event of agent.runTurn('go', signal())) {
        events.push(event);
        if (event.type === 'tool_start') agent.steer('actually, look in src/');
      }

      const second = requests[1]?.messages ?? [];
      const steered = second.filter(
        (message) =>
          message.role === 'user' &&
          message.content.some(
            (part) => part.type === 'text' && part.text === 'actually, look in src/',
          ),
      );
      expect(steered).toHaveLength(1);
      // Injected after the tool result, so the model is never handed a user turn
      // between its own tool call and that call's result.
      expect(second.at(-1)).toBe(steered[0] as never);
      expect(agent.pendingSteers).toBe(0);
    });
  });

  test('steering does not cancel the turn', async () => {
    await withTempDir(async (dir) => {
      const { agent } = agentFor([{ calls: [{ name: 'ls', input: {} }] }, { text: 'ok' }], dir);
      const events: AgentEvent[] = [];
      for await (const event of agent.runTurn('go', signal())) {
        events.push(event);
        if (event.type === 'tool_start') agent.steer('one more thing');
      }
      expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'stop' });
    });
  });
});

describe('interruption', () => {
  test('aborting mid-turn ends the turn as aborted', async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController();
      const { agent } = agentFor(
        [{ calls: [{ name: 'ls', input: {} }] }, { calls: [{ name: 'ls', input: {} }] }],
        dir,
      );

      const events: AgentEvent[] = [];
      for await (const event of agent.runTurn('go', controller.signal)) {
        events.push(event);
        if (event.type === 'tool_end') controller.abort();
      }
      expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'aborted' });
    });
  });
});

describe('the permission gate', () => {
  test('a denied call becomes an error result and the loop continues', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] }, { text: 'ok' }],
        dir,
        { mode: 'ask', prompt: async () => ({ kind: 'deny', message: 'no thanks' }) },
      );
      const events = await collect(agent.runTurn('go', signal()));

      expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'stop' });
      expect(await readFile(join(dir, 'a.txt'), 'utf8').catch(() => undefined)).toBeUndefined();
      const part = (requests[1]?.messages ?? []).find((m) => m.role === 'tool')?.content[0];
      if (part?.type === 'tool_result' && part.output.type === 'text') {
        expect(part.output.value).toContain('no thanks');
      }
    });
  });

  test('the prompt receives the real diff, not a description of it', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'old\n');
      let shown = '';
      const { agent } = agentFor(
        [
          { calls: [{ name: 'write', input: { path: 'a.txt', content: 'new\n' } }] },
          { text: 'ok' },
        ],
        dir,
        {
          mode: 'ask',
          prompt: async (request): Promise<PromptChoice> => {
            shown = request.detail;
            return { kind: 'allow-once' };
          },
        },
      );
      await collect(agent.runTurn('go', signal()));

      expect(shown).toContain('-old');
      expect(shown).toContain('+new');
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new\n');
    });
  });

  test('"always allow" stops the second call of the same shape from prompting', async () => {
    await withTempDir(async (dir) => {
      let prompts = 0;
      const { agent } = agentFor(
        [
          { calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] },
          { calls: [{ name: 'write', input: { path: 'a.txt', content: 'y' } }] },
          { text: 'ok' },
        ],
        dir,
        {
          mode: 'ask',
          prompt: async (): Promise<PromptChoice> => {
            prompts++;
            return { kind: 'allow-always', scope: 'session' };
          },
        },
      );
      await collect(agent.runTurn('go', signal()));
      expect(prompts).toBe(1);
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('y');
    });
  });

  test('a deny rule refuses without ever reaching the prompt', async () => {
    await withTempDir(async (dir) => {
      let prompted = false;
      const { agent } = agentFor(
        [{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] }, { text: 'ok' }],
        dir,
        {
          mode: 'yolo',
          rules: [parseRule('Write(*)', 'deny', 'project')],
          prompt: async (): Promise<PromptChoice> => {
            prompted = true;
            return { kind: 'allow-once' };
          },
        },
      );
      await collect(agent.runTurn('go', signal()));
      expect(prompted).toBe(false);
      expect(await readFile(join(dir, 'a.txt'), 'utf8').catch(() => undefined)).toBeUndefined();
    });
  });

  test('with no prompt available, an ask becomes an explained refusal', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] }, { text: 'ok' }],
        dir,
        { mode: 'ask' },
      );
      await collect(agent.runTurn('go', signal()));
      const part = (requests[1]?.messages ?? []).find((m) => m.role === 'tool')?.content[0];
      if (part?.type === 'tool_result' && part.output.type === 'text') {
        expect(part.output.value).toContain('cannot prompt for approval');
      }
    });
  });

  test('plan mode refuses a write and tells the model not to route around it', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] }, { text: 'ok' }],
        dir,
        { mode: 'plan' },
      );
      await collect(agent.runTurn('go', signal()));
      const part = (requests[1]?.messages ?? []).find((m) => m.role === 'tool')?.content[0];
      if (part?.type === 'tool_result' && part.output.type === 'text') {
        expect(part.output.value).toContain('plan mode');
      }
      expect(await readFile(join(dir, 'a.txt'), 'utf8').catch(() => undefined)).toBeUndefined();
    });
  });
});

describe('ask_user', () => {
  test('the answer comes back as the tool result', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [
          { calls: [{ name: 'ask_user', input: { question: 'Postgres or SQLite?' } }] },
          { text: 'ok' },
        ],
        dir,
        { ask: async () => 'SQLite' },
      );
      await collect(agent.runTurn('go', signal()));
      const part = (requests[1]?.messages ?? []).find((m) => m.role === 'tool')?.content[0];
      if (part?.type === 'tool_result' && part.output.type === 'text') {
        expect(part.output.value).toBe('SQLite');
      }
    });
  });

  test('with no way to ask, the model is told to state its assumption instead', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [{ name: 'ask_user', input: { question: 'which?' } }] }, { text: 'ok' }],
        dir,
      );
      await collect(agent.runTurn('go', signal()));
      const part = (requests[1]?.messages ?? []).find((m) => m.role === 'tool')?.content[0];
      if (part?.type === 'tool_result' && part.output.type === 'text') {
        expect(part.output.value).toContain('state the assumption');
      }
    });
  });
});
