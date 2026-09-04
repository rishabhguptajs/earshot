import { describe, expect, test } from 'bun:test';
import type { Message } from '@earshot/providers';
import { Agent } from '../src/agent.ts';
import {
  capResults,
  compact,
  DEFAULT_SHAPER_OPTIONS,
  estimateTokens,
  outputText,
  pruneResults,
  safeCutPoints,
  shouldCompact,
} from '../src/context/index.ts';
import { withTempDir } from './helpers.ts';
import { scripted } from './scripted-model.ts';

function toolResult(id: string, text: string, name = 'read'): Message {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolCallId: id,
        toolName: name,
        output: { type: 'text', value: text },
      },
    ],
  };
}

function toolCall(id: string, name = 'read'): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', toolCallId: id, toolName: name, input: {} }],
  };
}

const text = (role: Message['role'], value: string): Message => ({
  role,
  content: [{ type: 'text', text: value }],
});

describe('capping a tool result', () => {
  test('keeps the start and the end of an oversized result', () => {
    const body = `HEAD${'x'.repeat(50_000)}TAIL`;
    const [shaped] = capResults([toolResult('a', body)], DEFAULT_SHAPER_OPTIONS);
    const out = outputText(shaped?.content[0] as never);

    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out.length).toBeLessThan(body.length);
  });

  test('leaves a result that already fits exactly as it was', () => {
    const message = toolResult('a', 'small');
    expect(capResults([message], DEFAULT_SHAPER_OPTIONS)[0]).toBe(message);
  });
});

describe('pruning older tool results', () => {
  const options = { ...DEFAULT_SHAPER_OPTIONS, keepDetailedBatches: 2, stubChars: 40 };

  test('recent results survive in full', () => {
    const messages = [toolResult('a', 'A'.repeat(500)), toolResult('b', 'B'.repeat(500))];
    expect(pruneResults(messages, options)).toEqual(messages);
  });

  test('an older result is reduced to a stub', () => {
    const messages = [
      toolResult('old', `first line\n${'A'.repeat(500)}`),
      toolResult('b', 'B'),
      toolResult('c', 'C'),
    ];
    const out = outputText(pruneResults(messages, options)[0]?.content[0] as never);

    expect(out).toContain('elided');
    expect(out).toContain('first line');
    expect(out.length).toBeLessThan(200);
  });

  test('the result part itself is never dropped, only shortened', () => {
    const messages = [
      toolResult('old', 'A'.repeat(500)),
      toolResult('b', 'B'),
      toolResult('c', 'C'),
    ];
    const part = pruneResults(messages, options)[0]?.content[0];

    expect(part?.type).toBe('tool_result');
    expect((part as { toolCallId: string }).toolCallId).toBe('old');
  });
});

describe('choosing where to cut the history', () => {
  test('never cuts between a tool call and its result', () => {
    const messages = [
      text('user', 'hi'),
      toolCall('a'),
      toolResult('a', 'ok'),
      text('user', 'next'),
    ];
    // Cutting at 2 would leave the result of call "a" without its call.
    expect(safeCutPoints(messages)).not.toContain(2);
    expect(safeCutPoints(messages)).toContain(3);
  });
});

describe('compaction', () => {
  const long = (n: number) =>
    Array.from({ length: n }, (_, i) => text(i % 2 ? 'assistant' : 'user', `message ${i}`));

  test('fires only once the window is nearly full', () => {
    const small = [text('user', 'hello')];
    expect(shouldCompact(small, '', 100_000)).toBe(false);
    expect(shouldCompact([text('user', 'x'.repeat(400_000))], '', 100_000)).toBe(true);
  });

  test('replaces the old messages with a summary and keeps the recent ones verbatim', async () => {
    const messages = long(20);
    const result = await compact({
      messages,
      system: '',
      contextWindow: 1000,
      policy: { threshold: 0.8, keepRecentMessages: 4 },
      todos: ['finish the parser'],
      summarize: async () => 'we were editing the parser',
    });

    expect(result?.messages).toHaveLength(5);
    expect(result?.messages.at(-1)).toEqual(messages.at(-1) as Message);
    const preamble = (result?.messages[0]?.content[0] as { text: string } | undefined)?.text ?? '';
    expect(preamble).toContain('we were editing the parser');
    expect(preamble).toContain('finish the parser');
  });

  test('summarising a history that is already short does nothing', async () => {
    const result = await compact({
      messages: long(2),
      system: '',
      contextWindow: 1000,
      policy: { threshold: 0.8, keepRecentMessages: 8 },
      summarize: async () => 'unused',
    });
    expect(result).toBeUndefined();
  });
});

describe('the loop applies the shapers', () => {
  test('an oversized tool result is capped before the next request is sent', async () => {
    await withTempDir(async (dir) => {
      const model = scripted([
        { calls: [{ name: 'read', input: { path: 'big.txt' } }] },
        { text: 'done' },
      ]);
      await Bun.write(`${dir}/big.txt`, 'x'.repeat(80_000));

      const agent = new Agent({
        registry: model.registry,
        model: model.model,
        cwd: dir,
        system: '',
        mode: 'auto',
        rules: [],
        shapers: { maxResultChars: 500 },
      });
      for await (const _ of agent.runTurn('read it', new AbortController().signal));

      const sent = model.requests.at(-1)?.messages ?? [];
      const results = sent.flatMap((message) =>
        message.content.filter((part) => part.type === 'tool_result'),
      );
      expect(results).toHaveLength(1);
      expect(outputText(results[0] as never).length).toBeLessThanOrEqual(500);
      // History itself is untouched: shaping is per request, not a rewrite.
      const stored = agent.history.flatMap((message) =>
        message.content.filter((part) => part.type === 'tool_result'),
      );
      expect(outputText(stored[0] as never).length).toBeGreaterThan(500);
    });
  });

  test('a full window compacts and the summary reaches the next request', async () => {
    await withTempDir(async (dir) => {
      const model = scripted([
        { calls: [{ name: 'ls', input: {} }] },
        { text: 'the summary of what happened' },
        { text: 'done' },
      ]);
      const agent = new Agent({
        registry: model.registry,
        model: model.model,
        cwd: dir,
        system: '',
        mode: 'auto',
        rules: [],
        // Any history at all is over this threshold, so the second model call
        // of the turn is preceded by compaction.
        compaction: { threshold: 0.0000001, keepRecentMessages: 1 },
      });

      const events = [];
      for await (const event of agent.runTurn('go', new AbortController().signal)) {
        events.push(event);
      }

      expect(events.some((event) => event.type === 'compacted')).toBe(true);
      const last = model.requests.at(-1)?.messages ?? [];
      const first = last[0]?.content[0] as { text: string };
      expect(first.text).toContain('the summary of what happened');
      expect(first.text).toContain('context-summary');
    });
  });

  test('the estimated context use is reported after a turn', async () => {
    await withTempDir(async (dir) => {
      const model = scripted([{ text: 'hi' }]);
      const agent = new Agent({
        registry: model.registry,
        model: model.model,
        cwd: dir,
        system: 'system',
        mode: 'auto',
        rules: [],
      });
      for await (const _ of agent.runTurn('hello', new AbortController().signal));

      expect(agent.contextUse.tokens).toBeGreaterThan(0);
      expect(agent.contextUse.window).toBe(100_000);
    });
  });
});

describe('estimating tokens', () => {
  test('grows with the size of the history', () => {
    const one = estimateTokens([text('user', 'a'.repeat(400))]);
    const two = estimateTokens([text('user', 'a'.repeat(400)), text('user', 'a'.repeat(400))]);
    expect(two).toBeGreaterThan(one);
  });
});
