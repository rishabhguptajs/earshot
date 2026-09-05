import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '@earshot/core';
import { parseFormat, SCHEMA, toStreamRecord } from '../src/output.ts';

describe('the headless output contract', () => {
  test('stamps every record with the schema it belongs to', () => {
    const record = toStreamRecord({ type: 'text_delta', text: 'hi' });
    expect(record).toEqual({ schema: SCHEMA, type: 'text', text: 'hi' });
  });

  test('is v1 today', () => {
    // Changing this string is a breaking change to a published contract, not a
    // refactor. If this test is failing, that is the question being asked.
    expect(SCHEMA).toBe('earshot.v1');
  });

  test('accepts a pinned version and refuses one it does not implement', () => {
    expect(parseFormat('json')).toBe('json');
    expect(parseFormat('json@v1')).toBe('json');
    expect(parseFormat('stream-json@v1')).toBe('stream-json');
    expect(parseFormat('json@v2')).toBeUndefined();
    expect(parseFormat('yaml')).toBeUndefined();
  });

  test('does not leak the internal event names', () => {
    // `AgentEvent` is ours to rename; the stream is not.
    expect(toStreamRecord({ type: 'text_delta', text: 'x' })?.type).toBe('text');
    expect(
      toStreamRecord({
        type: 'tool_start',
        call: { type: 'tool_call', toolCallId: 'c1', toolName: 'read', input: {} },
      })?.type,
    ).toBe('tool_use');
  });

  test('reports a tool result with its error flag rather than dropping it', () => {
    const record = toStreamRecord({
      type: 'tool_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { output: { type: 'text', value: 'boom' }, isError: true },
    });
    expect(record).toMatchObject({ type: 'tool_result', isError: true, toolName: 'bash' });
  });

  test('says a call needed approval without putting the diff in the stream', () => {
    const record = toStreamRecord({
      type: 'permission',
      request: {
        tool: 'Write',
        target: 'a.txt',
        title: 'write a.txt',
        detail: 'THE-WHOLE-DIFF',
      },
      reason: 'no rule covers this',
    });
    expect(record?.type).toBe('permission');
    expect(JSON.stringify(record)).not.toContain('THE-WHOLE-DIFF');
  });

  test('emits nothing for events the stream already covers', () => {
    const covered: AgentEvent[] = [
      { type: 'message', message: { role: 'assistant', content: [] } },
      { type: 'turn_end', reason: 'stop' },
    ];
    for (const event of covered) expect(toStreamRecord(event)).toBeUndefined();
  });
});
