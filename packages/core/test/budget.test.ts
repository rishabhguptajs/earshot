import { describe, expect, test } from 'bun:test';
import { Agent, type AgentEvent } from '../src/agent.ts';
import { buildSystemPrompt } from '../src/context/system-prompt.ts';
import { scripted } from './scripted-model.ts';

const signal = () => new AbortController().signal;

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** Two turns, so the second call is the one the budget can stop. */
function budgeted(overrides: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const model = scripted([
    { calls: [{ id: '1', name: 'ls', input: { path: '.' } }] },
    { text: 'done' },
  ]);
  const agent = new Agent({
    registry: model.registry,
    model: model.model,
    cwd: '/workspace',
    system: 'test system',
    mode: 'auto',
    rules: [],
    ...overrides,
  });
  return { agent, requests: model.requests };
}

describe('the cost budget', () => {
  test('does not stop a session that is under it', async () => {
    const { agent } = budgeted({ maxCostUsd: 1000 });
    const events = await collect(agent.runTurn('hello', signal()));
    expect(events.some((event) => event.type === 'budget')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'stop' });
  });

  test('stops before the next model call, not after the money is gone', async () => {
    // Any spend at all is over a budget this small, so the check bites between
    // the first call and the second rather than at the end of the turn.
    const { agent, requests } = budgeted({ maxCostUsd: 0.0000001 });
    const events = await collect(agent.runTurn('hello', signal()));

    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'budget' });
    const budget = events.find((event) => event.type === 'budget');
    expect(budget).toMatchObject({ limitUsd: 0.0000001 });
    expect(budget && 'raisedTo' in budget ? budget.raisedTo : undefined).toBeUndefined();
  });

  test('continues when the user raises it, and says so', async () => {
    const asked: Array<[number, number]> = [];
    const { agent, requests } = budgeted({
      maxCostUsd: 0.0000001,
      confirmBudget: async (spent, limit) => {
        asked.push([spent, limit]);
        return 100;
      },
    });
    const events = await collect(agent.runTurn('hello', signal()));

    expect(asked).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(events.find((event) => event.type === 'budget')).toMatchObject({ raisedTo: 100 });
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'stop' });
    expect(agent.budgetUsd).toBe(100);
  });

  test('treats an answer at or below what is already spent as a stop', async () => {
    const { agent } = budgeted({
      maxCostUsd: 0.0000001,
      // Answering with the limit that was just exceeded would loop forever.
      confirmBudget: async (_spent, limit) => limit,
    });
    const events = await collect(agent.runTurn('hello', signal()));
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'budget' });
  });

  test('a session with no budget is never asked about one', async () => {
    let asked = 0;
    const { agent } = budgeted({
      confirmBudget: async () => {
        asked++;
        return undefined;
      },
    });
    await collect(agent.runTurn('hello', signal()));
    expect(asked).toBe(0);
  });
});

describe('curiosity', () => {
  const build = (curiosity?: 'low' | 'normal' | 'high') =>
    buildSystemPrompt({
      cwd: '/workspace',
      mode: 'auto',
      model: 'test/scripted',
      memory: '',
      preferences: '',
      ...(curiosity ? { curiosity } : {}),
    });

  test('defaults to normal', async () => {
    expect(await build()).toContain('<curiosity>normal</curiosity>');
  });

  test('moves the threshold at each level', async () => {
    expect(await build('low')).toContain('Decide rather than ask');
    expect(await build('high')).toContain('Ask whenever a second reading');
  });

  test('never turns asking off, and never makes it free', async () => {
    for (const level of ['low', 'normal', 'high'] as const) {
      const prompt = await build(level);
      expect(prompt).toContain('ask_user');
      // The two rules that hold at every level: the harness owns permission,
      // and an obvious default is not a question.
      expect(prompt).toContain('permission is handled by the harness');
      expect(prompt).toContain('obvious default');
    }
  });
});
