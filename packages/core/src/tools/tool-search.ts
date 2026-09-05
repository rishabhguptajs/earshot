import { defineTool, type Tool, ToolInputError, text } from './types.ts';

/**
 * The tools a search surfaces at once. A query matching forty tools and pasting
 * forty schemas back would reintroduce exactly the problem deferral solves.
 */
const MAX_RESULTS = 10;

export interface DeferredTools {
  /** Every deferred tool in the session, surfaced or not. */
  all(): Tool<never>[];
  /** Marks a tool as offered to the model from the next call onwards. */
  surface(name: string): void;
  surfaced(name: string): boolean;
}

/**
 * Search over tools that are registered but not in the prompt.
 *
 * Read-only by design: it grants nothing. Surfacing a tool only makes its schema
 * visible to the model, and calling it still goes through the same permission
 * gate it would have gone through had it been in the list all along.
 */
export function toolSearchTool(deferred: DeferredTools): Tool<{ query: string; limit?: number }> {
  return defineTool<{ query: string; limit?: number }>({
    name: 'tool_search',
    description:
      `${deferred.all().length} further tools are available but not listed above, because ` +
      'listing them all would cost more context than they are worth. This finds them and ' +
      'adds them to your tool list. Search by what you want to do ("create a pull request", ' +
      '"query the database"), by server name, or by an exact tool name. Call it before ' +
      'concluding a capability is missing.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to match against tool names and descriptions.',
        },
        limit: {
          type: 'number',
          description: `Maximum tools to surface, 1-${MAX_RESULTS}. Defaults to ${MAX_RESULTS}.`,
        },
      },
      required: ['query'],
    },
    parse: (input) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new ToolInputError('expected an object with a "query" string');
      }
      const { query, limit } = input as { query?: unknown; limit?: unknown };
      if (typeof query !== 'string' || query.trim() === '') {
        throw new ToolInputError('"query" must be a non-empty string');
      }
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) {
        throw new ToolInputError('"limit" must be a number');
      }
      return { query, ...(limit === undefined ? {} : { limit }) };
    },
    async execute(input) {
      const limit = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(input.limit ?? MAX_RESULTS)));
      const matches = rank(deferred.all(), input.query).slice(0, limit);
      if (matches.length === 0) {
        return {
          output: text(`No unlisted tool matches "${input.query}".`),
          title: `tool_search: no match for "${input.query}"`,
        };
      }

      for (const tool of matches) deferred.surface(tool.name);
      const body = matches
        .map(
          (tool) =>
            `${tool.name}\n${tool.description}\ninput schema: ${JSON.stringify(tool.inputSchema)}`,
        )
        .join('\n\n');
      return {
        output: text(
          `${matches.length} tool${matches.length === 1 ? '' : 's'} added to your tool list. ` +
            `You can call ${matches.length === 1 ? 'it' : 'them'} now.\n\n${body}`,
        ),
        title: `tool_search: ${matches.map((tool) => tool.name).join(', ')}`,
      };
    },
  });
}

/**
 * Substring scoring over name and description. Deliberately not fuzzy: a search
 * that silently matches something close is how the model ends up calling the
 * wrong server's `delete` tool. An unmatched query returns nothing and says so.
 */
function rank(tools: Tool<never>[], query: string): Tool<never>[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return [];

  const scored: Array<{ tool: Tool<never>; score: number }> = [];
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 3;
      else if (description.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ tool, score });
  }

  // Ties broken by name so the same query surfaces the same tools every time;
  // a search whose results shift between runs is not one a user can rely on.
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return scored.map((entry) => entry.tool);
}
