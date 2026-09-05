import {
  type Message,
  type Model,
  type ModelRequest,
  type Provider,
  ProviderRegistry,
  type StreamEvent,
  type ToolCallPart,
  type WireApi,
} from '@earshot/providers';
import type { ResolvedModel } from '../src/model.ts';

/** One scripted model turn: some text, and zero or more tool calls. */
export interface ScriptedTurn {
  text?: string;
  calls?: Array<{ id?: string; name: string; input: unknown }>;
}

export interface Scripted {
  registry: ProviderRegistry;
  model: ResolvedModel;
  /** Every request the loop made, so tests can assert on what history was sent. */
  requests: ModelRequest[];
}

const MODEL: Model = {
  id: 'scripted',
  providerId: 'test',
  name: 'Scripted',
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  cost: { input: 1, output: 1 },
  capabilities: { tools: true, vision: false, reasoning: false },
  api: 'openai-completions',
};

/**
 * A provider that replays a fixed script. The loop is the thing under test, so
 * the model's only job here is to be exactly predictable - including emitting a
 * `finish` with a fully assembled message, which the loop depends on.
 */
export function scripted(turns: ScriptedTurn[]): Scripted {
  const requests: ModelRequest[] = [];
  let next = 0;
  const model: Model = { ...MODEL, capabilities: { ...MODEL.capabilities } };

  const wire: WireApi = {
    kind: 'openai-completions',
    async *stream(req): AsyncIterable<StreamEvent> {
      // Snapshotted so a test can compare what successive calls were sent.
      requests.push({ ...req, messages: [...req.messages] });
      const turn = turns[next++] ?? {};

      const content: Message['content'] = [];
      if (turn.text !== undefined) {
        yield { type: 'text_delta', text: turn.text };
        content.push({ type: 'text', text: turn.text });
      }

      for (const [i, call] of (turn.calls ?? []).entries()) {
        const part: ToolCallPart = {
          type: 'tool_call',
          toolCallId: call.id ?? `call_${next}_${i}`,
          toolName: call.name,
          input: call.input,
        };
        yield { type: 'tool_call_start', toolCallId: part.toolCallId, toolName: part.toolName };
        yield {
          type: 'tool_call_end',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        };
        content.push(part);
      }

      const usage = { inputTokens: 10, outputTokens: 5 };
      yield { type: 'usage', usage };
      yield {
        type: 'finish',
        reason: (turn.calls ?? []).length > 0 ? 'tool_calls' : 'stop',
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

  const registry = new ProviderRegistry().register(provider).registerWire(wire);
  return {
    registry,
    model: { provider, model, credentials: { type: 'ambient' } },
    requests,
  };
}
