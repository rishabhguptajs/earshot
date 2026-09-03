import type { ToolDefinition } from '@earshot/providers';
import { askUserTool } from './ask-user.ts';
import { bashOutputTool, bashTool } from './bash.ts';
import { editTool, multiEditTool } from './edit.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { lsTool } from './ls.ts';
import { readTool } from './read.ts';
import { todoTool } from './todo.ts';
import type { Tool } from './types.ts';
import { webFetchTool } from './web-fetch.ts';
import { writeTool } from './write.ts';

export * from './diff.ts';
export { applyEdits } from './edit.ts';
export * from './exec.ts';
export * from './fs-paths.ts';
export * from './glob-match.ts';
export * from './jobs.ts';
export * from './schema.ts';
export * from './shell.ts';
export * from './todo.ts';
export * from './types.ts';
export * from './walk.ts';
export { htmlToText } from './web-fetch.ts';

/**
 * Order matters only for how the model reads the list, and reading tools first is
 * the order we want it to work in: look before you change anything.
 */
export const BUILTIN_TOOLS: Tool<never>[] = [
  readTool,
  lsTool,
  globTool,
  grepTool,
  editTool,
  multiEditTool,
  writeTool,
  bashTool,
  bashOutputTool,
  webFetchTool,
  askUserTool,
  todoTool,
] as unknown as Tool<never>[];

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<never>>();

  constructor(tools: Iterable<Tool<never>> = BUILTIN_TOOLS) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: Tool<never>): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool "${tool.name}"`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<never> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<never>[] {
    return [...this.tools.values()];
  }

  /** Only the tools a given permission mode allows are offered to the model. */
  definitions(filter?: (tool: Tool<never>) => boolean): ToolDefinition[] {
    return this.list()
      .filter((tool) => filter?.(tool) ?? true)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }
}
