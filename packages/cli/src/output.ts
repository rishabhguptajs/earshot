import type { AgentEvent } from '@earshot/core';

/**
 * The version of the headless output contract.
 *
 * What `earshot.v1` promises, and what it does not:
 *
 * - Every object earshot writes to stdout in a JSON format carries this string,
 *   so a consumer can tell which contract it is reading without knowing which
 *   binary produced it.
 * - Within v1, fields and record types may be **added**. A consumer must ignore
 *   records whose `type` it does not know and fields it did not expect. That is
 *   the whole compatibility rule, and it is what lets earshot report new things
 *   without breaking anything already parsing the stream.
 * - Renaming a field, removing one, or changing what one means requires v2. v2
 *   would be requested explicitly - `--output-format json@v2` - and v1 would
 *   keep working alongside it, so an upgrade is never the thing that breaks a
 *   script.
 *
 * The internal `AgentEvent` union is deliberately not what gets written: it is
 * ours to rename, and a consumer should not be able to notice when we do.
 */
export const SCHEMA = 'earshot.v1';

export type OutputFormat = 'text' | 'json' | 'stream-json';

/** `json`, `stream-json`, and the pinned forms `json@v1` / `stream-json@v1`. */
export function parseFormat(value: string): OutputFormat | undefined {
  const [name, version] = value.split('@');
  if (version !== undefined && version !== 'v1') return undefined;
  if (name === 'text' && version === undefined) return 'text';
  if (name === 'json' || name === 'stream-json') return name;
  return undefined;
}

export interface ResultRecord {
  schema: string;
  type: 'result';
  /** `success` unless something stopped the turn; `isError` is the short form. */
  subtype: 'success' | 'error' | 'interrupted' | 'max_steps';
  isError: boolean;
  text: string;
  costUsd: number;
  durationMs: number;
  numMessages: number;
  model: string;
  permissionMode: string;
  sessionId?: string;
  error?: { kind: string; message: string };
}

export type StreamRecord = { schema: string; type: string } & Record<string, unknown>;

/**
 * One agent event as a stream record.
 *
 * Events with nothing a consumer can act on return undefined rather than an
 * empty record. Text deltas are passed through as they arrive: a program
 * consuming the stream wants the same incremental output a person watching the
 * terminal gets, or there is no reason to stream at all.
 */
export function toStreamRecord(event: AgentEvent): StreamRecord | undefined {
  const base = { schema: SCHEMA };
  switch (event.type) {
    case 'model_start':
      return { ...base, type: 'model_start', model: event.model };
    case 'text_delta':
      return { ...base, type: 'text', text: event.text };
    case 'reasoning_delta':
      return { ...base, type: 'reasoning', text: event.text };
    case 'tool_start':
      return {
        ...base,
        type: 'tool_use',
        toolCallId: event.call.toolCallId,
        toolName: event.call.toolName,
        input: event.call.input,
      };
    case 'tool_end':
      return {
        ...base,
        type: 'tool_result',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.result.isError === true,
        output: event.result.output,
      };
    case 'permission':
      return {
        ...base,
        type: 'permission',
        tool: event.request.tool,
        target: event.request.target,
        title: event.request.title,
        reason: event.reason,
      };
    case 'usage':
      return { ...base, type: 'usage', usage: event.usage, costUsd: event.costUsd };
    case 'compacted':
      return { ...base, type: 'compacted', replaced: event.replaced };
    case 'scope_concern':
      return {
        ...base,
        type: 'scope',
        kind: event.concern.kind,
        summary: event.concern.summary,
        accepted: event.accepted,
      };
    case 'verification':
      return {
        ...base,
        type: 'verification',
        command: event.result.command,
        exitCode: event.result.exitCode,
        output: event.result.output,
      };
    case 'hook':
      return {
        ...base,
        type: 'hook',
        event: event.event,
        ...(event.blocked !== undefined ? { blocked: event.blocked } : {}),
        problems: event.problems,
      };
    case 'subagent':
      return {
        ...base,
        type: 'subagent',
        description: event.description,
        steps: event.steps,
        costUsd: event.costUsd,
      };
    case 'error':
      return {
        ...base,
        type: 'error',
        kind: event.error.kind,
        message: event.error.message,
        retryable: event.error.retryable,
      };
    // `message` and `turn_end` are covered by the records above and by the final
    // result record; emitting the raw assistant message as well would put the
    // same text in the stream twice.
    default:
      return undefined;
  }
}
