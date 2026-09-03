import { readFile, stat } from 'node:fs/promises';
import { displayPath, resolvePath } from './fs-paths.ts';
import { num, object, opt, optionalNumber, requireString, str } from './schema.ts';
import { defineTool, type Tool, ToolInputError, text } from './types.ts';

/** Lines beyond this are truncated unless the model asks for a window. */
const DEFAULT_LIMIT = 2000;
/** Longer lines are almost always minified or binary-ish; they blow the context. */
const MAX_LINE = 2000;

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export const readTool: Tool<ReadInput> = defineTool<ReadInput>({
  name: 'read',
  description:
    'Read a file from disk. Returns cat -n style numbered lines. Prefer reading a ' +
    'whole file over guessing a window; use offset/limit only for large files.',
  readOnly: true,
  inputSchema: object(
    {
      path: str('Path to the file, absolute or relative to the working directory.'),
      offset: num('1-based line to start from.'),
      limit: num('Maximum number of lines to return.'),
    },
    ['path'],
  ),
  parse: (input) => ({
    path: requireString(input, 'path'),
    ...opt('offset', optionalNumber(input, 'offset')),
    ...opt('limit', optionalNumber(input, 'limit')),
  }),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new ToolInputError(`no such file: ${displayPath(ctx.cwd, abs)}`);
    if (info.isDirectory()) {
      throw new ToolInputError(`${displayPath(ctx.cwd, abs)} is a directory; use ls`);
    }

    const raw = await readFile(abs, 'utf8');
    // Reading is what unlocks editing: the loop refuses an edit to a file this
    // session has not seen, so a stale model guess cannot silently overwrite work.
    ctx.markRead(abs);

    if (raw === '') return { output: text('(empty file)'), title: displayPath(ctx.cwd, abs) };

    const all = raw.split('\n');
    const start = Math.max(0, (input.offset ?? 1) - 1);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const slice = all.slice(start, start + limit);

    const body = slice
      .map((line, i) => {
        const shown = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… (truncated)` : line;
        return `${String(start + i + 1).padStart(6)}\t${shown}`;
      })
      .join('\n');

    const omitted = all.length - (start + slice.length);
    const note = omitted > 0 ? `\n\n… ${omitted} more lines; read with offset to continue` : '';
    return {
      output: text(body + note),
      title: `${displayPath(ctx.cwd, abs)} (${all.length} lines)`,
    };
  },
});
