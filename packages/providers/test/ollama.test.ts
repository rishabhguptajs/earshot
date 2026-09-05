import { describe, expect, test } from 'bun:test';
import type { ModelRequest, StreamEvent } from '../src/types.ts';
import { ollamaNativeWire } from '../src/wire/ollama.ts';

/**
 * The one hand-written adapter, so it gets the guarantees the shared bridge
 * gives every other one: exactly one finish, an assembled message, tool calls
 * with ids, and failures as errors rather than throws.
 */
function respondWith(lines: string[], status = 200): { fetch: typeof fetch; sent: () => unknown } {
  let body: unknown;
  const stub = (async (_url: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    if (status !== 200) return new Response('nope', { status });
    return new Response(
      new ReadableStream({
        start(controller) {
          // Deliberately split mid-line: a chunk boundary inside a JSON object
          // is the case that works in testing and breaks on a long response.
          const text = lines.map((line) => `${line}\n`).join('');
          const half = Math.floor(text.length / 2);
          controller.enqueue(new TextEncoder().encode(text.slice(0, half)));
          controller.enqueue(new TextEncoder().encode(text.slice(half)));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetch: stub, sent: () => body };
}

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  modelId: 'qwen3',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  ...over,
});

async function collect(
  lines: string[],
  over?: Partial<ModelRequest>,
  status = 200,
): Promise<{ events: StreamEvent[]; sent: unknown }> {
  const stub = respondWith(lines, status);
  const original = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  try {
    const events: StreamEvent[] = [];
    for await (const event of ollamaNativeWire.stream(request(over), {
      baseUrl: 'http://127.0.0.1:11434',
      credentials: { type: 'ambient' },
    })) {
      events.push(event);
    }
    return { events, sent: stub.sent() };
  } finally {
    globalThis.fetch = original;
  }
}

const done = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    message: { role: 'assistant', content: '' },
    done: true,
    prompt_eval_count: 12,
    eval_count: 7,
    ...extra,
  });

describe('the native ollama adapter', () => {
  test('streams text and assembles it into one message', async () => {
    const { events } = await collect([
      JSON.stringify({ message: { content: 'Hello' } }),
      JSON.stringify({ message: { content: ' world' } }),
      done(),
    ]);

    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(2);
    const finish = events.find((event) => event.type === 'finish');
    expect(finish?.type === 'finish' && finish.message.content).toEqual([
      { type: 'text', text: 'Hello world' },
    ]);
  });

  test('keeps tool calls, which the OpenAI-compatible endpoint drops', async () => {
    const { events } = await collect([
      JSON.stringify({
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read', arguments: { path: 'a.txt' } } }],
        },
      }),
      done({ done_reason: 'stop' }),
    ]);

    const ended = events.find((event) => event.type === 'tool_call_end');
    expect(ended?.type === 'tool_call_end' && ended.toolName).toBe('read');
    expect(ended?.type === 'tool_call_end' && ended.input).toEqual({ path: 'a.txt' });

    const finish = events.find((event) => event.type === 'finish');
    expect(finish?.type === 'finish' && finish.reason).toBe('tool_calls');
  });

  test('gives every tool call an id, since ollama supplies none', async () => {
    const { events } = await collect([
      JSON.stringify({
        message: {
          tool_calls: [
            { function: { name: 'read', arguments: {} } },
            { function: { name: 'read', arguments: {} } },
          ],
        },
      }),
      done(),
    ]);

    const ids = events
      .filter((event) => event.type === 'tool_call_end')
      .map((event) => (event.type === 'tool_call_end' ? event.toolCallId : ''));
    // Distinct, and non-empty: the loop matches results to calls by id.
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id !== '')).toBe(true);
  });

  test('reports thinking as reasoning rather than as text', async () => {
    const { events } = await collect([
      JSON.stringify({ message: { thinking: 'let me see', content: '' } }),
      JSON.stringify({ message: { content: 'the answer' } }),
      done(),
    ]);

    expect(events.some((event) => event.type === 'reasoning_delta')).toBe(true);
    const finish = events.find((event) => event.type === 'finish');
    expect(finish?.type === 'finish' && finish.message.content[0]).toEqual({
      type: 'reasoning',
      text: 'let me see',
    });
  });

  test('reports usage from the final chunk', async () => {
    const { events } = await collect([JSON.stringify({ message: { content: 'x' } }), done()]);
    const finish = events.find((event) => event.type === 'finish');
    expect(finish?.type === 'finish' && finish.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  test('sends tool results back keyed to the tool that produced them', async () => {
    const { sent } = await collect([done()], {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', toolCallId: 'c1', toolName: 'read', input: {} }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'c1',
              toolName: 'read',
              output: { type: 'text', value: 'contents' },
            },
          ],
        },
      ],
    });

    const messages = (sent as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages.at(-1)).toEqual({ role: 'tool', tool_name: 'read', content: 'contents' });
  });

  test('produces an error event rather than throwing when ollama is not running', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      const events: StreamEvent[] = [];
      for await (const event of ollamaNativeWire.stream(request(), {
        credentials: { type: 'ambient' },
      })) {
        events.push(event);
      }
      expect(events[0]?.type).toBe('error');
      expect(events[0]?.type === 'error' && events[0].error.kind).toBe('network');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('maps an http failure onto the shared error taxonomy', async () => {
    const { events } = await collect([], undefined, 500);
    expect(events[0]?.type === 'error' && events[0].error.kind).toBe('server');
    expect(events[0]?.type === 'error' && events[0].error.retryable).toBe(true);
  });
});
