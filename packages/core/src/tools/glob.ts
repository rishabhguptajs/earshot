import { stat } from 'node:fs/promises';
import { displayPath, resolvePath } from './fs-paths.ts';
import { globToRegExp } from './glob-match.ts';
import { num, object, opt, optionalNumber, optionalString, requireString, str } from './schema.ts';
import { defineTool, type Tool, text } from './types.ts';
import { loadGitignore, walk } from './walk.ts';

const DEFAULT_LIMIT = 200;

interface GlobInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export const globTool: Tool<GlobInput> = defineTool<GlobInput>({
  name: 'glob',
  description:
    'Find files by glob pattern. Supports *, **, ? and {a,b}. A pattern with no ' +
    'slash matches at any depth, so `*.ts` finds `src/main.ts`. Results are sorted ' +
    'by most recently modified.',
  readOnly: true,
  inputSchema: object(
    {
      pattern: str('Glob pattern, e.g. `src/**/*.ts` or `*.json`.'),
      path: str('Directory to search under. Defaults to the working directory.'),
      limit: num(`Maximum results. Defaults to ${DEFAULT_LIMIT}.`),
    },
    ['pattern'],
  ),
  parse: (input) => ({
    pattern: requireString(input, 'pattern'),
    ...opt('path', optionalString(input, 'path')),
    ...opt('limit', optionalNumber(input, 'limit')),
  }),
  async execute(input, ctx) {
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    const limit = input.limit ?? DEFAULT_LIMIT;
    const matcher = globToRegExp(input.pattern);
    const ignore = await loadGitignore(root);

    const found: Array<{ rel: string; mtimeMs: number }> = [];
    for await (const entry of walk({ root, ignore, signal: ctx.signal })) {
      if (!matcher.test(entry.rel)) continue;
      const info = await stat(entry.path).catch(() => undefined);
      found.push({ rel: entry.rel, mtimeMs: info?.mtimeMs ?? 0 });
    }

    // Recency ordering is the useful default: the files a developer is working in
    // are the ones they just touched, and the limit should cut the stale tail.
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const shown = found.slice(0, limit);
    const where = displayPath(ctx.cwd, root);

    if (shown.length === 0) {
      return { output: text(`no files match ${input.pattern}`), title: input.pattern };
    }
    const more = found.length > shown.length ? `\n\n… ${found.length - shown.length} more` : '';
    return {
      output: text(shown.map((f) => f.rel).join('\n') + more),
      title: `${input.pattern} in ${where} (${found.length} matches)`,
    };
  },
});
