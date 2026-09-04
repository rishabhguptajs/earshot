import { describe, expect, test } from 'bun:test';
import { decide, parseRule } from '@earshot/core';
import { MAX_RESULT_CHARS, truncate } from '../src/client.ts';
import { MAX_TOOL_NAME, mcpTool, namespacedName } from '../src/tool.ts';
import { descriptor, FakeServer, toolContext } from './helpers.ts';

describe('a tool an MCP server supplied', () => {
  test('is never read-only, whatever the server says about itself', () => {
    const server = new FakeServer('github');
    const tool = mcpTool(server, {
      ...descriptor('search'),
      // A server asserting its own harmlessness. Believing it would let it run
      // in parallel and without a prompt.
      annotations: { readOnlyHint: true },
    } as never);

    expect(tool.readOnly).toBe(false);
    expect(tool.permission).toBeDefined();
  });

  test('describes the call to the gate with its real arguments', () => {
    const tool = mcpTool(new FakeServer('github'), descriptor('create_issue'));
    const request = tool.permission?.({ title: 'hi', body: 'secret' }, toolContext());

    expect(request?.tool).toBe('Mcp');
    expect(request?.target).toBe('github__create_issue');
    expect(request?.detail).toContain('"body": "secret"');
  });

  test('is refused by a deny rule naming it, like any other tool', () => {
    const tool = mcpTool(new FakeServer('github'), descriptor('create_issue'));
    const request = tool.permission?.({}, toolContext());
    const decision = decide(tool as never, request, {
      mode: 'yolo',
      rules: [parseRule('Mcp(github__*)', 'deny', 'global')],
      cwd: '/work',
    });

    expect(decision.outcome).toBe('deny');
  });

  test('prompts in auto mode unless a rule names that exact tool', () => {
    const tool = mcpTool(new FakeServer('github'), descriptor('create_issue'));
    const request = tool.permission?.({}, toolContext());
    const allowOther = decide(tool as never, request, {
      mode: 'ask',
      rules: [parseRule('Mcp(github__search)', 'allow', 'local')],
      cwd: '/work',
    });

    expect(allowOther.outcome).toBe('ask');
  });

  test('reports a failing call as a result the model can read, not a throw', async () => {
    const server = new FakeServer('flaky', {
      respond: () => ({ text: 'upstream returned 500', isError: true }),
    });
    const tool = mcpTool(server, descriptor('fetch'));
    const result = await tool.execute(tool.parse({ q: 'x' }), toolContext());

    expect(result.isError).toBe(true);
    expect(result.output).toEqual({ type: 'text', value: 'upstream returned 500' });
  });

  test('rejects arguments that are not an object before the server sees them', () => {
    const tool = mcpTool(new FakeServer('github'), descriptor('search'));
    expect(() => tool.parse(['not', 'an', 'object'])).toThrow();
  });
});

describe('tool naming', () => {
  test('keeps two servers offering the same tool name apart', () => {
    expect(namespacedName('github', 'search')).toBe('github__search');
    expect(namespacedName('gitlab', 'search')).toBe('gitlab__search');
  });

  test('stays inside the length providers accept, and is stable across runs', () => {
    const long = 'a'.repeat(90);
    const first = namespacedName('server', long);
    expect(first.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
    expect(namespacedName('server', long)).toBe(first);
    expect(namespacedName('server', `${long}b`)).not.toBe(first);
  });
});

describe('a server that floods', () => {
  test('has its output cut in the middle, keeping both ends', () => {
    const flood = `START${'x'.repeat(MAX_RESULT_CHARS * 2)}END`;
    const cut = truncate(flood);

    expect(cut.length).toBeLessThan(flood.length);
    expect(cut.startsWith('START')).toBe(true);
    expect(cut.endsWith('END')).toBe(true);
    expect(cut).toContain('dropped by earshot');
  });
});
