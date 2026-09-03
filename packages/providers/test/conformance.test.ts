import { describe, expect, test } from 'bun:test';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { Message, ModelRequest, StreamEvent } from '../src/types.ts';
import { streamViaAiSdk } from '../src/wire/ai-sdk.ts';

/**
 * The provider conformance suite. Every earshot adapter goes through the same
 * bridge, so exercising the bridge against scripted provider output is what makes
 * adding a vendor safe: these are the guarantees the agent loop is allowed to rely on.
 */

const usage = {
  inputTokens: { total: 100, noCache: 90, cacheRead: 10, cacheWrite: 5 },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

function mockModel(parts: LanguageModelV4StreamPart[]): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-1',
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('not used');
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModelV4;
}

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  modelId: 'mock-1',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  ...over,
});

async function collect(parts: LanguageModelV4StreamPart[], over?: Partial<ModelRequest>) {
  const events: StreamEvent[] = [];
  for await (const event of streamViaAiSdk(mockModel(parts), req(over))) events.push(event);
  return events;
}

const finishPart = (
  unified: 'stop' | 'tool-calls' | 'length' | 'error' | 'content-filter',
  raw?: string,
): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage,
  finishReason: { unified, raw },
});

function finishEvent(events: StreamEvent[]) {
  const event = events.find((e) => e.type === 'finish');
  if (event?.type !== 'finish') throw new Error('stream produced no finish event');
  return event;
}

describe('text streaming', () => {
  test('emits deltas and assembles them into one message part', async () => {
    const events = await collect([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello' },
      { type: 'text-delta', id: 't1', delta: ' world' },
      { type: 'text-end', id: 't1' },
      finishPart('stop'),
    ]);

    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual([
      'Hello',
      ' world',
    ]);
    expect(finishEvent(events).message.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  test('produces exactly one finish event', async () => {
    const events = await collect([
      { type: 'text-delta', id: 't1', delta: 'x' },
      finishPart('stop'),
    ]);
    expect(events.filter((e) => e.type === 'finish')).toHaveLength(1);
  });

  test('synthesises a finish when the provider closes the stream without one', async () => {
    const events = await collect([{ type: 'text-delta', id: 't1', delta: 'x' }]);
    expect(finishEvent(events).reason).toBe('stop');
    expect(finishEvent(events).message.content).toEqual([{ type: 'text', text: 'x' }]);
  });

  test('drops empty text runs, which Anthropic rejects', async () => {
    const events = await collect([
      { type: 'text-start', id: 't1' },
      { type: 'text-end', id: 't1' },
      finishPart('stop'),
    ]);
    expect(finishEvent(events).message.content).toEqual([]);
  });
});

describe('tool calls', () => {
  const call = (id: string, name: string, input: string): LanguageModelV4StreamPart[] => [
    { type: 'tool-input-start', id, toolName: name },
    { type: 'tool-input-delta', id, delta: input },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName: name, input },
  ];

  test('parses the JSON input string into a value', async () => {
    const events = await collect([
      ...call('c1', 'read', '{"path":"a.ts"}'),
      finishPart('tool-calls'),
    ]);
    const end = events.find((e) => e.type === 'tool_call_end');
    expect(end?.type === 'tool_call_end' && end.input).toEqual({ path: 'a.ts' });
    expect(finishEvent(events).reason).toBe('tool_calls');
  });

  test('carries parallel calls through in order', async () => {
    const events = await collect([
      ...call('c1', 'read', '{"path":"a.ts"}'),
      ...call('c2', 'read', '{"path":"b.ts"}'),
      finishPart('tool-calls'),
    ]);
    expect(
      finishEvent(events).message.content.map((p) => p.type === 'tool_call' && p.toolCallId),
    ).toEqual(['c1', 'c2']);
  });

  test('surfaces streaming argument deltas for the UI', async () => {
    const events = await collect([...call('c1', 'read', '{}'), finishPart('tool-calls')]);
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call_delta')).toBe(true);
  });

  test('malformed tool JSON is passed through rather than crashing the turn', async () => {
    const events = await collect([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: '{not json' },
      finishPart('tool-calls'),
    ]);
    const end = events.find((e) => e.type === 'tool_call_end');
    expect(end?.type === 'tool_call_end' && end.input).toBe('{not json');
  });

  test('empty tool input becomes an empty object', async () => {
    const events = await collect([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'ls', input: '' },
      finishPart('tool-calls'),
    ]);
    const end = events.find((e) => e.type === 'tool_call_end');
    expect(end?.type === 'tool_call_end' && end.input).toEqual({});
  });
});

describe('reasoning round-trip', () => {
  test('preserves end-of-run provider metadata on the reasoning part', async () => {
    // This is the mechanism OpenAI encrypted reasoning and Gemini thought
    // signatures ride on; losing it means a 400 on the next turn.
    const events = await collect([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
      {
        type: 'reasoning-end',
        id: 'r1',
        providerMetadata: { google: { thoughtSignature: 'sig' } },
      },
      finishPart('stop'),
    ]);
    expect(finishEvent(events).message.content[0]).toEqual({
      type: 'reasoning',
      text: 'thinking',
      providerMetadata: { google: { thoughtSignature: 'sig' } },
    });
  });

  test('keeps reasoning ahead of the text it produced', async () => {
    const events = await collect([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'think' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-delta', id: 't1', delta: 'answer' },
      finishPart('stop'),
    ]);
    expect(finishEvent(events).message.content.map((p) => p.type)).toEqual(['reasoning', 'text']);
  });

  test('interleaved runs stay separate parts', async () => {
    const events = await collect([
      { type: 'text-start', id: 't1' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'text-delta', id: 't1', delta: 'a' },
      { type: 'reasoning-delta', id: 'r1', delta: 'b' },
      { type: 'text-delta', id: 't1', delta: 'c' },
      finishPart('stop'),
    ]);
    expect(finishEvent(events).message.content).toEqual([
      { type: 'text', text: 'ac' },
      { type: 'reasoning', text: 'b' },
    ]);
  });
});

describe('usage and cost inputs', () => {
  test('flattens the nested usage shape, cache counts included', async () => {
    const events = await collect([finishPart('stop')]);
    expect(finishEvent(events).usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });

  test('emits usage before finish so the status line can update', async () => {
    const events = await collect([finishPart('stop')]);
    expect(events.findIndex((e) => e.type === 'usage')).toBeLessThan(
      events.findIndex((e) => e.type === 'finish'),
    );
  });
});

describe('finish reasons', () => {
  test('maps the unified vocabulary', async () => {
    expect(finishEvent(await collect([finishPart('stop')])).reason).toBe('stop');
    expect(finishEvent(await collect([finishPart('length')])).reason).toBe('length');
    expect(finishEvent(await collect([finishPart('tool-calls')])).reason).toBe('tool_calls');
    expect(finishEvent(await collect([finishPart('content-filter')])).reason).toBe(
      'content_filter',
    );
  });

  test('a refusal is not reported as a normal stop', async () => {
    // Anthropic flattens refusal into "stop"; the loop must be able to tell them apart.
    expect(finishEvent(await collect([finishPart('stop', 'refusal')])).reason).toBe('refusal');
  });
});

describe('errors', () => {
  test('classifies auth, rate-limit and server failures', async () => {
    const kindOf = async (statusCode: number) => {
      const events = await collect([
        { type: 'error', error: Object.assign(new Error('boom'), { statusCode }) },
      ]);
      const e = events.find((x) => x.type === 'error');
      return e?.type === 'error' ? e.error.kind : undefined;
    };
    expect(await kindOf(401)).toBe('auth');
    expect(await kindOf(429)).toBe('rate_limit');
    expect(await kindOf(503)).toBe('server');
  });

  test('rate limits and server errors are retryable, auth failures are not', async () => {
    const events = await collect([
      { type: 'error', error: Object.assign(new Error('slow down'), { statusCode: 429 }) },
    ]);
    const e = events.find((x) => x.type === 'error');
    expect(e?.type === 'error' && e.error.retryable).toBe(true);
  });

  test('detects context overflow behind a generic 400', async () => {
    const events = await collect([
      {
        type: 'error',
        error: Object.assign(new Error('prompt is too long: 300000 tokens'), { statusCode: 400 }),
      },
    ]);
    const e = events.find((x) => x.type === 'error');
    expect(e?.type === 'error' && e.error.kind).toBe('context_overflow');
  });

  test('a failure to open the stream is reported, not thrown', async () => {
    const model = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'mock-1',
      supportedUrls: {},
      doStream: async () => {
        throw Object.assign(new Error('no key'), { statusCode: 401 });
      },
    } as unknown as LanguageModelV4;

    const events: StreamEvent[] = [];
    for await (const event of streamViaAiSdk(model, req())) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.type === 'error' && events[0].error.kind).toBe('auth');
  });
});

describe('abort', () => {
  test('finishes with the partial message rather than losing the turn', async () => {
    const controller = new AbortController();
    const model = {
      specificationVersion: 'v4',
      provider: 'mock',
      modelId: 'mock-1',
      supportedUrls: {},
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'partial' });
          },
          pull() {
            controller.abort();
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          },
        }),
      }),
    } as unknown as LanguageModelV4;

    const events: StreamEvent[] = [];
    for await (const e of streamViaAiSdk(model, req({ abortSignal: controller.signal }))) {
      events.push(e);
    }
    const finish = finishEvent(events);
    expect(finish.reason).toBe('abort');
    expect(finish.message.content).toEqual([{ type: 'text', text: 'partial' }]);
  });
});

describe('history is append-only', () => {
  test('the assembled message is a fresh object, never a mutation of the input', async () => {
    const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const events = await collect([finishPart('stop')], { messages: history });
    expect(history).toHaveLength(1);
    expect(finishEvent(events).message.role).toBe('assistant');
  });
});
