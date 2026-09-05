import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '@earshot/core';
import { LOCAL_SETTINGS, McpManager } from '@earshot/mcp';
import { EXTENSION_TRUST_NOTE, loadExtensions } from './modules.ts';

export * from './modules.ts';

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
  const local = await loadLocalExtensions(cwd);
  const manager = await McpManager.start({ cwd }).catch((error: Error) => {
    return { error } as const;
  });

  if ('error' in manager) {
    return {
      tools: local.tools,
      problems: [...local.problems, `mcp servers could not be started: ${manager.error.message}`],
      summary: local.summary,
      close: async () => {},
    };
  }

  const failures = manager.reports
    .filter((report) => report.status !== 'ready')
    .map((report) => `mcp server "${report.name}" ${report.detail ?? 'did not start'}`);

  const mcpTools = manager.tools();
  const deferred = mcpTools.length > TOOL_SEARCH_THRESHOLD;

  return {
    tools: [
      ...local.tools,
      ...(deferred ? mcpTools.map((tool) => ({ ...tool, deferred: true })) : mcpTools),
    ],
    problems: [...local.problems, ...manager.problems, ...failures],
    summary: [
      ...local.summary,
      ...manager.summary(),
      ...(deferred
        ? [`${mcpTools.length} mcp tools: found with tool_search rather than listed in full`]
        : []),
    ],
    close: () => manager.close(),
  };
}

/**
 * In-process extensions, kept separate from MCP tools: they are never deferred
 * behind `tool_search`. A user who wrote a tool into their own config directory
 * expects the model to see it, and there are never a hundred of them.
 */
async function loadLocalExtensions(
  cwd: string,
): Promise<{ tools: Tool<never>[]; problems: string[]; summary: string[] }> {
  const { tools, reports } = await loadExtensions(cwd, await trustedExtensions(cwd));
  return {
    tools,
    problems: reports
      .filter((report) => report.status === 'failed')
      .map((report) => `extension "${report.name}" failed to load: ${report.detail ?? 'unknown'}`),
    summary: reports.map((report) => {
      if (report.status === 'untrusted') return `${report.name}: ${EXTENSION_TRUST_NOTE}`;
      if (report.status === 'failed') return `${report.name}: ${report.detail ?? 'failed'}`;
      return `${report.name}: ${report.toolCount} tool${report.toolCount === 1 ? '' : 's'}`;
    }),
  };
}

export async function trustedExtensions(cwd: string): Promise<Set<string>> {
  const raw = await readFile(join(cwd, LOCAL_SETTINGS), 'utf8').catch(() => '{}');
  try {
    const parsed = JSON.parse(raw) as { extensionTrust?: unknown };
    return new Set(
      Array.isArray(parsed.extensionTrust)
        ? parsed.extensionTrust.filter((name): name is string => typeof name === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}
