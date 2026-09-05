import type * as acp from '@agentclientprotocol/sdk';
import type { AgentEvent } from '@earshot/core';

export function updateFromEvent(
  event: AgentEvent,
  context: { tokens: number; window: number; costUsd: number },
): acp.SessionUpdate | undefined {
  switch (event.type) {
    case 'text_delta':
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: event.text },
      };
    case 'reasoning_delta':
      return {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: event.text },
      };
    case 'tool_start':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: event.call.toolCallId,
        title: event.call.toolName,
        kind: toolKind(event.call.toolName),
        status: 'in_progress',
        rawInput: event.call.input,
      };
    case 'tool_end':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolCallId,
        status: event.result.isError ? 'failed' : 'completed',
        rawOutput: outputValue(event.result.output),
        content: [{ type: 'content', content: contentOf(event.result.output) }],
      };
    case 'usage':
      return {
        sessionUpdate: 'usage_update',
        used: context.tokens,
        size: context.window,
        cost: { amount: context.costUsd, currency: 'USD' },
      };
    default:
      return undefined;
  }
}

function toolKind(name: string): acp.ToolKind {
  if (name === 'read' || name === 'ls') return 'read';
  if (name === 'write' || name === 'edit' || name === 'multi_edit') return 'edit';
  if (name === 'grep' || name === 'glob') return 'search';
  if (name === 'bash' || name === 'bash_output') return 'execute';
  if (name === 'web_fetch') return 'fetch';
  if (name === 'todo' || name === 'declare_scope') return 'think';
  return 'other';
}

function outputValue(output: { type: string; value: unknown }): unknown {
  return output.value;
}

function contentOf(output: { type: string; value: unknown }): acp.ContentBlock {
  if (output.type === 'text') return { type: 'text', text: String(output.value) };
  return { type: 'text', text: JSON.stringify(output.value) ?? String(output.value) };
}
