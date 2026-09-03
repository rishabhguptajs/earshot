import { readdir, stat } from 'node:fs/promises';
import { displayPath, resolvePath } from './fs-paths.ts';
import { object, optionalString, str } from './schema.ts';
import { defineTool, type Tool, ToolInputError, text } from './types.ts';

interface LsInput {
  path?: string;
}

export const lsTool: Tool<LsInput> = defineTool<LsInput>({
  name: 'ls',
  description:
    'List the entries of one directory. Use `glob` to find files by pattern across ' +
    'a tree; this tool does not recurse.',
  readOnly: true,
  inputSchema: object({ path: str('Directory to list. Defaults to the working directory.') }, []),
  parse: (input) => {
    const path = optionalString(input, 'path');
    return path === undefined ? {} : { path };
  },
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path ?? '.');
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new ToolInputError(`no such directory: ${displayPath(ctx.cwd, abs)}`);
    if (!info.isDirectory())
      throw new ToolInputError(`${displayPath(ctx.cwd, abs)} is a file; use read`);

    const entries = await readdir(abs, { withFileTypes: true });
    const rows = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => {
        const dirA = a.endsWith('/');
        const dirB = b.endsWith('/');
        return dirA === dirB ? a.localeCompare(b) : dirA ? -1 : 1;
      });

    return {
      output: text(rows.length === 0 ? '(empty directory)' : rows.join('\n')),
      title: `${displayPath(ctx.cwd, abs)} (${rows.length} entries)`,
    };
  },
});
