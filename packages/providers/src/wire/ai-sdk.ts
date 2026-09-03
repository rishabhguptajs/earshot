import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { earshotError } from '../errors.ts';
import type {
  FinishReason,
  Message,
  MessagePart,
  ModelRequest,
  ProviderMetadata,
  ReasoningEffort,
  StreamEvent,
  Usage,
  WireApi,
  WireApiKind,
  WireContext,
} from '../types.ts';
import { toPrompt } from './ai-sdk-prompt.ts';

/** Builds the concrete LanguageModelV4 for a request. One per provider package. */
export type ModelFactory = (modelId: string, ctx: WireContext) => LanguageModelV4;

/**
 * The single bridge between our unified types and the AI SDK's LanguageModelV4
 * spec. Every AI SDK provider package becomes an earshot wire adapter by passing
 * its model factory here, which is what keeps "adding a provider" to a config entry.
 */
export function createAiSdkWire(kind: WireApiKind, factory: ModelFactory): WireApi {
  return {
    kind,
    async *stream(req, ctx) {
      yield* streamViaAiSdk(factory(req.modelId, ctx), req);
    },
  };
}

export async function* streamViaAiSdk(
  model: LanguageModelV4,
  req: ModelRequest,
): AsyncIterable<StreamEvent> {
  const builder = new MessageBuilder();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let finished = false;

  let stream: ReadableStream<LanguageModelV4StreamPart>;
  try {
    ({ stream } = await model.doStream(toCallOptions(req)));
  } catch (error) {
    yield { type: 'error', error: toEarshotError(error) };
    return;
  }

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of mapPart(value, builder)) {
        if (event.type === 'usage') usage = event.usage;
        if (event.type === 'finish') finished = true;
        yield event;
      }
    }
  } catch (error) {
    if (req.abortSignal?.aborted) {
      yield { type: 'finish', reason: 'abort', usage, message: builder.build() };
      return;
    }
    yield { type: 'error', error: toEarshotError(error) };
    return;
  } finally {
    reader.releaseLock();
  }

  // Some providers close the stream without a terminal finish part; the agent loop
  // relies on exactly one finish event carrying the assembled message.
  if (!finished) {
    yield { type: 'finish', reason: 'stop', usage, message: builder.build() };
  }
}

function toCallOptions(req: ModelRequest): LanguageModelV4CallOptions {
  return {
    prompt: toPrompt(req),
    ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    ...(req.reasoningEffort ? { reasoning: toReasoning(req.reasoningEffort) } : {}),
    ...(req.providerOptions ? { providerOptions: req.providerOptions } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      : {}),
    ...(req.toolChoice
      ? { toolChoice: { type: req.toolChoice === 'auto' ? 'auto' : req.toolChoice } }
      : {}),
  };
}

type SdkReasoning = NonNullable<LanguageModelV4CallOptions['reasoning']>;

function toReasoning(effort: ReasoningEffort): SdkReasoning {
  return effort satisfies SdkReasoning;
}

/**
 * Accumulates streamed parts into the assistant message that gets appended to
 * history. Text and reasoning arrive as start/delta/end runs keyed by id, so each
 * run becomes one part - preserving per-part providerMetadata for replay.
 */
class MessageBuilder {
  #parts: MessagePart[] = [];
  #open = new Map<string, { index: number; kind: 'text' | 'reasoning' }>();

  startRun(id: string, kind: 'text' | 'reasoning', meta?: ProviderMetadata): void {
    const part: MessagePart =
      kind === 'text'
        ? { type: 'text', text: '', ...(meta ? { providerMetadata: meta } : {}) }
        : { type: 'reasoning', text: '', ...(meta ? { providerMetadata: meta } : {}) };
    this.#open.set(id, { index: this.#parts.push(part) - 1, kind });
  }

  appendRun(id: string, kind: 'text' | 'reasoning', delta: string): void {
    let open = this.#open.get(id);
    if (!open) {
      this.startRun(id, kind);
      open = this.#open.get(id) as { index: number; kind: 'text' | 'reasoning' };
    }
    const part = this.#parts[open.index];
    if (part && (part.type === 'text' || part.type === 'reasoning')) part.text += delta;
  }

  /** End-of-run metadata wins: providers attach signatures and encrypted blobs here. */
  endRun(id: string, meta?: ProviderMetadata): void {
    const open = this.#open.get(id);
    this.#open.delete(id);
    if (!open || !meta) return;
    const part = this.#parts[open.index];
    if (part) part.providerMetadata = { ...part.providerMetadata, ...meta };
  }

  addToolCall(toolCallId: string, toolName: string, input: unknown, meta?: ProviderMetadata): void {
    this.#parts.push({
      type: 'tool_call',
      toolCallId,
      toolName,
      input,
      ...(meta ? { providerMetadata: meta } : {}),
    });
  }

  build(): Message {
    // Empty runs are dropped: Anthropic rejects zero-length content blocks.
    return {
      role: 'assistant',
      content: this.#parts.filter(
        (p) => !((p.type === 'text' || p.type === 'reasoning') && p.text === ''),
      ),
    };
  }
}

function mapPart(part: LanguageModelV4StreamPart, builder: MessageBuilder): StreamEvent[] {
  switch (part.type) {
    case 'text-start':
      builder.startRun(part.id, 'text', part.providerMetadata);
      return [];
    case 'text-delta':
      builder.appendRun(part.id, 'text', part.delta);
      return [{ type: 'text_delta', text: part.delta }];
    case 'text-end':
      builder.endRun(part.id, part.providerMetadata);
      return [];

    case 'reasoning-start':
      builder.startRun(part.id, 'reasoning', part.providerMetadata);
      return [];
    case 'reasoning-delta':
      builder.appendRun(part.id, 'reasoning', part.delta);
      return [
        {
          type: 'reasoning_delta',
          text: part.delta,
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
        },
      ];
    case 'reasoning-end':
      builder.endRun(part.id, part.providerMetadata);
      return [];

    case 'tool-input-start':
      return [{ type: 'tool_call_start', toolCallId: part.id, toolName: part.toolName }];
    case 'tool-input-delta':
      return [{ type: 'tool_call_delta', toolCallId: part.id, argsTextDelta: part.delta }];
    case 'tool-input-end':
      return [];

    case 'tool-call': {
      // Spec carries tool input as a JSON string; everything above us wants a value.
      const input = parseToolInput(part.input);
      builder.addToolCall(part.toolCallId, part.toolName, input, part.providerMetadata);
      return [
        {
          type: 'tool_call_end',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input,
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
        },
      ];
    }

    case 'finish': {
      const usage = toUsage(part.usage);
      return [
        { type: 'usage', usage },
        {
          type: 'finish',
          reason: toFinishReason(part.finishReason),
          usage,
          message: builder.build(),
        },
      ];
    }

    case 'error':
      return [{ type: 'error', error: toEarshotError(part.error) }];

    default:
      // stream-start, response-metadata, raw, source, file, and provider-executed
      // tool results carry nothing the agent loop acts on yet.
      return [];
  }
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  if (input.trim() === '') return {};
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function toUsage(usage: LanguageModelV4Usage): Usage {
  return {
    inputTokens: usage.inputTokens.total ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    ...(usage.outputTokens.reasoning != null
      ? { reasoningTokens: usage.outputTokens.reasoning }
      : {}),
    ...(usage.inputTokens.cacheRead != null
      ? { cacheReadTokens: usage.inputTokens.cacheRead }
      : {}),
    ...(usage.inputTokens.cacheWrite != null
      ? { cacheWriteTokens: usage.inputTokens.cacheWrite }
      : {}),
  };
}

function toFinishReason(reason: LanguageModelV4FinishReason): FinishReason {
  // `raw` preserves vendor detail the unified value flattens away - Anthropic's
  // "refusal" is a distinct stop reason the loop must not treat as a normal stop.
  if (reason.raw === 'refusal') return 'refusal';
  switch (reason.unified) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
      return 'tool_calls';
    case 'content-filter':
      return 'content_filter';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

function toEarshotError(error: unknown) {
  const e = error as {
    name?: string;
    statusCode?: number;
    message?: string;
    isRetryable?: boolean;
  };
  if (e?.name === 'AbortError')
    return earshotError('abort', 'request aborted', { retryable: false });

  const status = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  const message = e?.message ?? String(error);
  const kind =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limit'
        : status !== undefined && status >= 500
          ? 'server'
          : status !== undefined
            ? 'invalid_request'
            : 'unknown';

  // Context overflow is only ever a 400 with a vendor-specific message.
  const overflow = /context length|too many tokens|maximum context|prompt is too long/i.test(
    message,
  );
  return earshotError(overflow ? 'context_overflow' : kind, message, {
    ...(status !== undefined ? { status } : {}),
    cause: error,
  });
}
