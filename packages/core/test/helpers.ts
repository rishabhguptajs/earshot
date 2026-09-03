import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundJobs } from '../src/tools/jobs.ts';
import { MemoryTodoStore } from '../src/tools/todo.ts';
import type { Tool, ToolContext, ToolResult } from '../src/tools/types.ts';

export interface TestContext extends ToolContext {
  /** Questions `ask_user` asked, in order. */
  asked: string[];
}

export function testContext(cwd: string, overrides: Partial<ToolContext> = {}): TestContext {
  const read = new Set<string>();
  const asked: string[] = [];
  return {
    cwd,
    signal: new AbortController().signal,
    todos: new MemoryTodoStore(),
    jobs: new BackgroundJobs(),
    env: process.env,
    asked,
    async ask(question) {
      asked.push(question);
      return 'answered';
    },
    markRead: (path) => read.add(path),
    hasRead: (path) => read.has(path),
    ...overrides,
  };
}

/** Parses and executes in one step, the way the loop does. */
export function run<I>(tool: Tool<I>, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  return tool.execute(tool.parse(input), ctx);
}

export function outputText(result: ToolResult): string {
  if (result.output.type !== 'text')
    throw new Error(`expected text output, got ${result.output.type}`);
  return result.output.value;
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'earshot-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
