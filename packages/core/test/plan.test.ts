import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Agent, type AgentEvent, type AgentOptions } from '../src/agent.ts';
import { openInEditor, readPlan, renderPlan, savePlan } from '../src/plan/index.ts';
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

describe('a plan', () => {
  test('is read back from the file, so an edit is what gets approved', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'plan.md');
      await savePlan(path, 'what the model wrote');
      // The user edits the file, as they would in $EDITOR.
      await savePlan(path, 'what the user decided instead');

      expect((await readPlan(path))?.trim()).toBe('what the user decided instead');
    });
  });

  test('is nothing when the file is empty rather than an empty instruction', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'plan.md');
      await savePlan(path, '   ');
      expect(await readPlan(path)).toBeUndefined();
    });
  });

  test('reaches the model as the user’s instruction, not as its own draft', () => {
    const rendered = renderPlan('Step one.');
    expect(rendered).toContain('Step one.');
    expect(rendered).toContain('The user approved this plan');
  });

  test('is pinned into every call once approved, and only until cleared', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor([{ text: 'a' }, { text: 'b' }, { text: 'c' }], dir);

      await collect(agent.runTurn('before', signal()));
      expect(requests[0]?.system).not.toContain('THE-PLAN');

      agent.setPlan('THE-PLAN');
      await collect(agent.runTurn('during', signal()));
      expect(requests[1]?.system).toContain('THE-PLAN');

      agent.setPlan(undefined);
      await collect(agent.runTurn('after', signal()));
      expect(requests[2]?.system).not.toContain('THE-PLAN');
    });
  });

  test('survives a system prompt rebuilt for a new memory', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor([{ text: 'a' }], dir);
      agent.setPlan('THE-PLAN');
      // What /memory does after saving a preference.
      agent.setSystem('a freshly built system prompt');

      await collect(agent.runTurn('go', signal()));
      expect(requests[0]?.system).toContain('a freshly built system prompt');
      expect(requests[0]?.system).toContain('THE-PLAN');
    });
  });

  test('travels with a subagent, which is bound by it too', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentFor(
        [
          { calls: [{ name: 'task', input: { description: 'sub', prompt: 'go' } }] },
          { text: 'sub answer' },
          { text: 'done' },
        ],
        dir,
      );
      agent.setPlan('THE-PLAN');
      await collect(agent.runTurn('go', signal()));

      expect(requests[1]?.system).toContain('THE-PLAN');
    });
  });

  test('names the file rather than guessing an editor when none is configured', async () => {
    const result = await openInEditor('/tmp/plan.md', {});
    expect(result.edited).toBe(false);
    expect(result.message).toContain('/tmp/plan.md');
  });
});

describe('the intent line', () => {
  test('precedes every tool batch, carrying one line of why', async () => {
    await withTempDir(async (dir) => {
      const { agent } = agentFor(
        [
          {
            text: 'Reading the config to find the timeout.\nThen I will change it.',
            calls: [{ name: 'ls', input: { path: '.' } }],
          },
          { text: 'done' },
        ],
        dir,
      );
      const events = await collect(agent.runTurn('find the timeout', signal()));

      const intent = events.find((event) => event.type === 'intent');
      expect(intent).toEqual({
        type: 'intent',
        text: 'Reading the config to find the timeout.',
        calls: 1,
      });
      // Before the tools it explains, or it explains nothing.
      expect(events.indexOf(intent as AgentEvent)).toBeLessThan(
        events.findIndex((event) => event.type === 'tool_start'),
      );
    });
  });

  test('reports a batch that arrived without one rather than passing it over', async () => {
    await withTempDir(async (dir) => {
      const { agent } = agentFor(
        [{ calls: [{ name: 'ls', input: { path: '.' } }] }, { text: 'done' }],
        dir,
      );
      const events = await collect(agent.runTurn('list it', signal()));

      const intent = events.find((event) => event.type === 'intent');
      expect(intent).toEqual({ type: 'intent', text: undefined, calls: 1 });
    });
  });
});
