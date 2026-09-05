import { earshotError, errorFromStatus } from '../errors.ts';
import type {
  Message,
  MessagePart,
  ModelRequest,
  StreamEvent,
  ToolCallPart,
  Usage,
  WireApi,
  WireContext,
} from '../types.ts';

/**
 * Ollama's native `/api/chat`, written by hand.
 *
 * The one adapter that is not a binding to an AI SDK provider package, because
 * the alternative is worse: Ollama's OpenAI-compatible `/v1` drops tool calls
 * from streamed responses entirely, so a local model could either stream or use
 * tools but not both. Ollama's own endpoint streams tool calls, and it is a
 * newline-delimited JSON protocol with about six fields - small enough to be
 * cheaper to write than to work around.
 */
export const ollamaNativeWire: WireApi = {
  kind: 'ollama-native',
  async *stream(req: ModelRequest, ctx: WireContext): AsyncIterable<StreamEvent> {
    const root = (ctx.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/v1\/?$/, '');
    const body = {
      model: req.modelId,
      messages: toOllamaMessages(req),
      stream: true,
      ...(req.tools?.length ? { tools: req.tools.map(toOllamaTool) } : {}),
      options: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxOutputTokens !== undefined ? { num_predict: req.maxOutputTokens } : {}),
      },
    };

    let response: Response;
    try {
      response = await fetch(`${root}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ctx.headers ?? {}) },
        body: JSON.stringify(body),
        ...(req.abortSignal ? { signal: req.abortSignal } : {}),
      });
    } catch (error) {
      yield { type: 'error', error: fromThrown(error) };
      return;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      yield {
        type: 'error',
        error: errorFromStatus(response.status, `ollama returned ${response.status}: ${text}`),
      };
      return;
    }

    const content: MessagePart[] = [];
    let text = '';
    let reasoning = '';
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let reason: 'stop' | 'length' | 'tool_calls' = 'stop';
    let calls = 0;

    try {
      for await (const chunk of ndjson(response.body)) {
        if (chunk.error) {
          yield { type: 'error', error: earshotError('server', String(chunk.error)) };
          return;
        }
        const message = chunk.message as Record<string, unknown> | undefined;

        // Ollama streams reasoning as a separate `thinking` field rather than
        // inline, so it never has to be recovered from tags in the text.
        const thinking = typeof message?.thinking === 'string' ? message.thinking : '';
        if (thinking !== '') {
          reasoning += thinking;
          yield { type: 'reasoning_delta', text: thinking };
        }

        const delta = typeof message?.content === 'string' ? message.content : '';
        if (delta !== '') {
          text += delta;
          yield { type: 'text_delta', text: delta };
        }

        for (const call of asArray(message?.tool_calls)) {
          const fn = (call as { function?: Record<string, unknown> }).function ?? {};
          const name = typeof fn.name === 'string' ? fn.name : '';
          if (name === '') continue;
          // Ollama emits a whole call at once rather than streaming its
          // arguments, and gives it no id, so one is synthesised - the loop
          // matches results to calls by id and cannot use an empty one.
          const toolCallId = `ollama_${Date.now().toString(36)}_${calls++}`;
          const part: ToolCallPart = {
            type: 'tool_call',
            toolCallId,
            toolName: name,
            input: fn.arguments ?? {},
          };
          yield { type: 'tool_call_start', toolCallId, toolName: name };
          yield { type: 'tool_call_end', toolCallId, toolName: name, input: part.input };
          content.push(part);
          reason = 'tool_calls';
        }

        if (chunk.done === true) {
          usage.inputTokens = numberOf(chunk.prompt_eval_count);
          usage.outputTokens = numberOf(chunk.eval_count);
          if (chunk.done_reason === 'length') reason = 'length';
        }
      }
    } catch (error) {
      yield { type: 'error', error: fromThrown(error) };
      return;
    }

    // Reasoning first, then text, then calls: the order the loop replays them in
    // and the order every other adapter produces.
    const assembled: MessagePart[] = [
      ...(reasoning !== '' ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      ...(text !== '' ? [{ type: 'text' as const, text }] : []),
      ...content,
    ];
    const message: Message = { role: 'assistant', content: assembled };

    yield { type: 'usage', usage };
    yield { type: 'finish', reason, usage, message };
  },
};

/**
 * An abort is not a failure to report as one: the loop distinguishes the user
 * interrupting from the server falling over, and treating both as `network`
 * would make an interrupted turn look retryable.
 */
function fromThrown(error: unknown) {
  const message = (error as Error)?.message ?? String(error);
  if ((error as Error)?.name === 'AbortError') {
    return earshotError('abort', 'the request was interrupted', { retryable: false });
  }
  return earshotError('network', `could not reach ollama: ${message}`);
}

/** Ollama's chat format: a flat list of role/content, with tool results by name. */
function toOllamaMessages(req: ModelRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (req.system) out.push({ role: 'system', content: req.system });

  for (const message of req.messages) {
    if (message.role === 'tool') {
      // One entry per result: Ollama has no multi-part tool message, and merging
      // them would lose which result answered which call.
      for (const part of message.content) {
        if (part.type !== 'tool_result') continue;
        out.push({ role: 'tool', tool_name: part.toolName, content: outputText(part.output) });
      }
      continue;
    }

    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    const toolCalls = message.content
      .filter((part): part is ToolCallPart => part.type === 'tool_call')
      .map((part) => ({ function: { name: part.toolName, arguments: part.input } }));

    if (text === '' && toolCalls.length === 0) continue;
    out.push({
      role: message.role,
      content: text,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
}

function toOllamaTool(tool: { name: string; description: string; inputSchema: unknown }) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function outputText(output: { type: string; value: unknown }): string {
  if (output.type === 'text') return String(output.value);
  return JSON.stringify(output.value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Ollama's stream is one JSON object per line. Buffered across chunks because a
 * chunk boundary lands mid-line often enough that parsing per chunk works in
 * testing and fails on a long response.
 */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') yield JSON.parse(line) as Record<string, unknown>;
      newline = buffer.indexOf('\n');
    }
  }
  const rest = buffer.trim();
  if (rest !== '') yield JSON.parse(rest) as Record<string, unknown>;
}
