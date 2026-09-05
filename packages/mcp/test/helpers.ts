import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@earshot/core';
import type { McpCallResult, McpClient, McpToolDescriptor } from '../src/client.ts';

export interface FakeOptions {
  tools?: McpToolDescriptor[];
  /** Answers a call. Throwing here stands in for a server that failed. */
  respond?: (tool: string, args: unknown) => Promise<McpCallResult> | McpCallResult;
  listTools?: () => Promise<McpToolDescriptor[]>;
}

export class FakeServer implements McpClient {
  readonly calls: Array<{ tool: string; args: unknown }> = [];
  closed = false;

  constructor(
    readonly name: string,
    private readonly options: FakeOptions = {},
  ) {}

  async listTools(): Promise<McpToolDescriptor[]> {
    if (this.options.listTools) return this.options.listTools();
    return this.options.tools ?? [];
  }

  async callTool(tool: string, args: unknown): Promise<McpCallResult> {
    this.calls.push({ tool, args });
    if (this.closed) return { text: 'server is gone', isError: true };
    const respond = this.options.respond;
    if (!respond) return { text: `${tool} ok`, isError: false };
    return respond(tool, args);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  diagnostics(): string {
    return '';
  }
}

export function descriptor(name: string, extra: Record<string, unknown> = {}): McpToolDescriptor {
  return {
    name,
    description: `does ${name}`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    ...extra,
  };
}

/** Only what an MCP tool actually reads; the rest of ToolContext is unused here. */
export function toolContext(signal = new AbortController().signal): ToolContext {
  return { signal } as unknown as ToolContext;
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'earshot-mcp-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
