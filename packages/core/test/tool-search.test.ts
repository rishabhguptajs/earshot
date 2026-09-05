import { describe, expect, test } from 'bun:test';
import { defineTool, type Tool, text, toolSearchTool } from '../src/tools/index.ts';
import type { ToolContext } from '../src/tools/types.ts';

function fake(name: string, description: string): Tool<never> {
  return defineTool({
    name,
    description,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    readOnly: true,
    parse: () => undefined as never,
    execute: async () => ({ output: text('') }),
  }) as unknown as Tool<never>;
}

const CATALOGUE = [
  fake('github__create_pull_request', 'Open a pull request on a repository'),
  fake('github__list_issues', 'List issues on a repository'),
  fake('postgres__query', 'Run a read-only SQL query against the database'),
];

function harness(tools = CATALOGUE) {
  const surfaced = new Set<string>();
  const tool = toolSearchTool({
    all: () => tools,
    surface: (name) => {
      surfaced.add(name);
    },
    surfaced: (name) => surfaced.has(name),
  });
  const run = (input: unknown) => tool.execute(tool.parse(input), {} as ToolContext);
  return { tool, surfaced, run };
}

describe('tool_search', () => {
  test('surfaces the tools a query matches and returns their schemas', async () => {
    const { surfaced, run } = harness();
    const result = await run({ query: 'open a pull request' });
    const output = result.output.type === 'text' ? result.output.value : '';

    expect(surfaced.has('github__create_pull_request')).toBe(true);
    expect(output).toContain('github__create_pull_request');
    expect(output).toContain('"type":"object"');
    expect(surfaced.has('postgres__query')).toBe(false);
  });

  test('ranks a name match above a description match', async () => {
    const { run } = harness();
    const result = await run({ query: 'issues' });
    expect(result.title).toBe('tool_search: github__list_issues');
  });

  test('says so rather than guessing when nothing matches', async () => {
    const { surfaced, run } = harness();
    const result = await run({ query: 'send a fax' });
    expect(surfaced.size).toBe(0);
    expect(result.output.type === 'text' && result.output.value).toContain('No unlisted tool');
  });

  test('caps how many tools one search can surface', async () => {
    const many = Array.from({ length: 40 }, (_, i) => fake(`server__query_${i}`, 'query things'));
    const { surfaced, run } = harness(many);
    await run({ query: 'query' });
    expect(surfaced.size).toBe(10);

    const { surfaced: few, run: runFew } = harness(many);
    await runFew({ query: 'query', limit: 2 });
    expect(few.size).toBe(2);
  });

  test('rejects an empty query instead of surfacing everything', () => {
    const { tool } = harness();
    expect(() => tool.parse({ query: '  ' })).toThrow('non-empty');
    expect(() => tool.parse('query')).toThrow('expected an object');
  });

  test('grants nothing by itself: it is read-only and adds no permission', () => {
    const { tool } = harness();
    expect(tool.readOnly).toBe(true);
    expect(tool.permission).toBeUndefined();
  });
});
