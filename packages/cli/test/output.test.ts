import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The published shape of every record, locked.
 *
 * This is what makes `earshot.v1` a contract rather than a paragraph. Adding a
 * record type or a field is allowed within v1 and only needs this table
 * extended; renaming or removing one is a v2 and fails here first. A test
 * failing in this block is not a broken build - it is the question "is this a
 * v2?" being asked at the moment somebody would otherwise have answered it by
 * accident. See docs/compatibility.md.
 */
describe('the v1 record shapes', () => {
  const sample: Array<[string, AgentEvent, string[]]> = [
    ['model_start', { type: 'model_start', model: 'm' }, ['model']],
    ['text', { type: 'text_delta', text: 't' }, ['text']],
    ['reasoning', { type: 'reasoning_delta', text: 't' }, ['text']],
    [
      'tool_use',
      {
        type: 'tool_start',
        call: { type: 'tool_call', toolCallId: 'c', toolName: 'read', input: {} },
      },
      ['toolCallId', 'toolName', 'input'],
    ],
    [
      'tool_result',
      {
        type: 'tool_end',
        toolCallId: 'c',
        toolName: 'read',
        result: { output: { type: 'text', value: 'v' } },
      },
      ['toolCallId', 'toolName', 'isError', 'output'],
    ],
    [
      'permission',
      {
        type: 'permission',
        request: { tool: 'Write', target: 'a', title: 'w', detail: 'd' },
        reason: 'r',
      },
      ['tool', 'target', 'title', 'reason'],
    ],
    ['intent', { type: 'intent', calls: 1, text: 'why' }, ['calls', 'text']],
    [
      'usage',
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 },
      ['usage', 'costUsd'],
    ],
    [
      'budget',
      { type: 'budget', spentUsd: 1, limitUsd: 1, raisedTo: 2 },
      ['spentUsd', 'limitUsd', 'raisedTo'],
    ],
    ['compacted', { type: 'compacted', replaced: 2 }, ['replaced']],
    [
      'scope',
      { type: 'scope_concern', concern: { kind: 'k', summary: 's' }, accepted: true },
      ['kind', 'summary', 'accepted'],
    ],
    [
      'verification',
      { type: 'verification', result: { command: 'c', exitCode: 0, output: 'o' } },
      ['command', 'exitCode', 'output'],
    ],
    [
      'hook',
      { type: 'hook', event: 'e', blocked: false, problems: [] },
      ['event', 'blocked', 'problems'],
    ],
    [
      'subagent',
      { type: 'subagent', description: 'd', steps: 1, costUsd: 0 },
      ['description', 'steps', 'costUsd'],
    ],
    [
      'error',
      { type: 'error', error: { kind: 'k', message: 'm', retryable: false } },
      ['kind', 'message', 'retryable'],
    ],
  ];

  for (const [type, event, fields] of sample) {
    test(`${type} carries exactly its published fields`, () => {
      const record = toStreamRecord(event);
      expect(record?.type).toBe(type);
      expect(Object.keys(record ?? {}).sort()).toEqual(['schema', 'type', ...fields].sort());
    });
  }

  test('the documented record types are exactly the ones emitted', () => {
    // The other direction, and the one that actually rots: a record type added
    // to the emitter without being written down ships an undocumented part of a
    // published contract, and a type deleted from the emitter leaves consumers
    // reading about something that never arrives. The reference table is the
    // published list, so it is compared against rather than trusted.
    const doc = readFileSync(join(import.meta.dir, '../../../docs/headless.md'), 'utf8');
    const start = doc.indexOf('| `type` | Fields |');
    // Bounded at the blank line that ends the table, or the exit-code table
    // further down the page joins the comparison and the failure is nonsense.
    const table = doc.slice(start, doc.indexOf('\n\n', start));
    const documented = [...table.matchAll(/^\| `(\w+)` \|/gm)]
      .map((match) => match[1])
      .filter((type) => type !== 'type');

    expect(new Set(documented)).toEqual(new Set([...sample.map(([type]) => type), 'result']));
  });

  test('the documented fields are exactly the ones each record carries', () => {
    // Types alone are not the contract - the field names are what a consumer
    // reads. Without this, a field could be renamed in the reference table while
    // the stream kept the old name, and the published documentation would be
    // wrong in the one place people trust it.
    const doc = readFileSync(join(import.meta.dir, '../../../docs/headless.md'), 'utf8');
    const start = doc.indexOf('| `type` | Fields |');
    const table = doc.slice(start, doc.indexOf('\n\n', start));

    for (const [type, , fields] of sample) {
      const row = table.split('\n').find((line) => line.startsWith(`| \`${type}\` |`));
      // Prose after an em dash explains a field; it does not name new ones.
      const cell = (row ?? '').split('|')[2]?.split('\u2014')[0] ?? '';
      const documented = [...cell.matchAll(/`(\w+)\??`/g)].map((match) => match[1]);
      expect({ type, fields: documented }).toEqual({ type, fields });
    }
  });
});
