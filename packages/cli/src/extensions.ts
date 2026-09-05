import type { Tool } from '@earshot/core';
import { McpManager } from '@earshot/mcp';

/**
 * Above this many MCP tools, their schemas stop being offered in every request
 * and are found with `tool_search` instead. Under it, listing them outright is
 * cheaper than making the model search: one round trip beats two.
 */
export const TOOL_SEARCH_THRESHOLD = 25;

export interface Extensions {
  tools: Tool<never>[];
  /** Lines worth showing before the first turn: a server that failed, a bad config. */
  problems: string[];
  /** One line per configured server, shown on request rather than at every start. */
  summary: string[];
  close(): Promise<void>;
}

/**
 * Everything outside core that contributes tools to a session.
 *
 * Assembled in the CLI rather than in core: core must not know that MCP exists,
 * or the dependency arrow between the two packages reverses. A failure here is
 * reported and the session still starts - a broken server config should cost the
 * user that server, not their agent.
 */
export async function startExtensions(cwd: string): Promise<Extensions> {
  const manager = await McpManager.start({ cwd }).catch((error: Error) => {
    return { error } as const;
  });

  if ('error' in manager) {
    return {
      tools: [],
      problems: [`mcp servers could not be started: ${manager.error.message}`],
      summary: [],
      close: async () => {},
    };
  }

  const failures = manager.reports
    .filter((report) => report.status !== 'ready')
    .map((report) => `mcp server "${report.name}" ${report.detail ?? 'did not start'}`);

  const mcpTools = manager.tools();
  const deferred = mcpTools.length > TOOL_SEARCH_THRESHOLD;

  return {
    tools: deferred ? mcpTools.map((tool) => ({ ...tool, deferred: true })) : mcpTools,
    problems: [...manager.problems, ...failures],
    summary: [
      ...manager.summary(),
      ...(deferred
        ? [`${mcpTools.length} mcp tools: found with tool_search rather than listed in full`]
        : []),
    ],
    close: () => manager.close(),
  };
}
