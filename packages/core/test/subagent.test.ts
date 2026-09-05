import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, type AgentEvent, type AgentOptions } from '../src/agent.ts';
import { parseRule } from '../src/permissions/rules.ts';
import { withTempDir } from './helpers.ts';
import { type ScriptedTurn, scripted } from './scripted-model.ts';

const signal = () => new AbortController().signal;

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

const spawn = (prompt: string, tools?: string[]) => ({
  name: 'task',
  input: { description: 'look it up', prompt, ...(tools ? { tools } : {}) },
});

describe('a subagent', () => {
  test('hands back its answer, not its transcript', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'the value is 41\n');
      const { agent, requests } = agentFor(
        [
          { calls: [spawn('what is in a.txt?')] },
          // The subagent's own turns.
          { calls: [{ name: 'read', input: { path: 'a.txt' } }] },
          { text: 'the value is 41' },
          { text: 'it says 41' },
        ],
        dir,
      );
      await collect(agent.runTurn('check a.txt', signal()));

      const parentHistory = JSON.stringify(agent.history);
      expect(parentHistory).toContain('the value is 41');
      // The subagent read the file; the parent never saw the read call itself.
      expect(
        agent.history.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some((part) => part.type === 'tool_call' && part.toolName === 'read'),
        ),
      ).toBe(false);
      expect(requests.length).toBeGreaterThan(2);
    });
  });

  test('spends onto the parent’s total, not beside it', async () => {
    await withTempDir(async (dir) => {
      const { agent } = agentFor(
        [{ calls: [spawn('go')] }, { text: 'sub answer' }, { text: 'done' }],
        dir,
      );
      const events = await collect(agent.runTurn('do it', signal()));

      // `usage` events are the parent's own calls; the subagent's are not among
      // them. The session's total is both, which is what a budget has to mean.
      const parentOwn = events
        .filter((event) => event.type === 'usage')
        .reduce((total, event) => total + (event.type === 'usage' ? event.costUsd : 0), 0);
      const sub = events.find((event) => event.type === 'subagent');
      const subCost = sub?.type === 'subagent' ? sub.costUsd : 0;

      expect(subCost).toBeGreaterThan(0);
      expect(agent.costUsd).toBeCloseTo(parentOwn + subCost, 10);
    });
  });

  test('is held to the scope the parent declared', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'declared.txt'), 'a\n');
      await writeFile(join(dir, 'other.txt'), 'b\n');
      const asked: string[] = [];

      const { agent } = agentFor(
        [
          {
            calls: [
              {
                name: 'declare_scope',
                input: { files: ['declared.txt'], intent: 'change one file', estimatedLines: 5 },
              },
            ],
          },
          { calls: [spawn('edit other.txt', ['read', 'write'])] },
          { calls: [{ name: 'write', input: { path: 'other.txt', content: 'changed\n' } }] },
          { text: 'edited it' },
          { text: 'done' },
        ],
        dir,
        {
          prompt: async (request) => {
            asked.push(request.title);
            return { kind: 'deny' };
          },
        },
      );
      await collect(agent.runTurn('change declared.txt', signal()));

      // The write happened inside the subagent, and still had to answer for a
      // file the parent's scope never listed.
      expect(asked.join('\n')).toContain('outside the declared scope');
    });
  });

  test('cannot be handed a tool the session does not have', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [spawn('go', ['read', 'bash'])] }, { text: 'sub' }, { text: 'done' }],
        dir,
        { tools: [] },
      );
      // The parent has no tools at all beyond what it was given, so the
      // subagent's request for `bash` cannot conjure one.
      await collect(agent.runTurn('do it', signal()));
      const subagentRequest = requests[1];
      expect((subagentRequest?.tools ?? []).map((tool) => tool.name)).toEqual([]);
    });
  });

  test('gets read-only tools when none are named', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [spawn('go')] }, { text: 'sub' }, { text: 'done' }],
        dir,
      );
      await collect(agent.runTurn('do it', signal()));

      const offered = (requests[1]?.tools ?? []).map((tool) => tool.name);
      expect(offered).toContain('read');
      expect(offered).not.toContain('write');
      expect(offered).not.toContain('bash');
    });
  });

  test('cannot spawn a subagent of its own', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [{ calls: [spawn('go', ['read', 'task'])] }, { text: 'sub' }, { text: 'done' }],
        dir,
      );
      await collect(agent.runTurn('do it', signal()));

      expect((requests[1]?.tools ?? []).map((tool) => tool.name)).not.toContain('task');
    });
  });

  test('is refused by a deny rule the same way any other tool is', async () => {
    await withTempDir(async (dir) => {
      const { agent } = agentFor([{ calls: [spawn('go')] }, { text: 'done' }], dir, {
        rules: [parseRule('Task', 'deny', 'global')],
      });
      const events = await collect(agent.runTurn('do it', signal()));

      const ended = events.find((event) => event.type === 'tool_end');
      expect(ended?.type === 'tool_end' && ended.result.isError).toBe(true);
    });
  });

  test('says so when it stopped early rather than passing off a partial answer', async () => {
    await withTempDir(async (dir) => {
      const { agent } = agentFor(
        [
          { calls: [spawn('go')] },
          // The subagent loops on a tool until its step budget runs out.
          ...Array.from({ length: 6 }, () => ({
            calls: [{ name: 'ls', input: { path: '.' } }],
          })),
          { text: 'done' },
        ],
        dir,
        { subagentMaxSteps: 3 },
      );
      const events = await collect(agent.runTurn('do it', signal()));

      const ended = events.find((event) => event.type === 'tool_end' && event.toolName === 'task');
      const output =
        ended?.type === 'tool_end' && ended.result.output.type === 'text'
          ? ended.result.output.value
          : '';
      expect(output).toContain('stopped early');
    });
  });
});
