import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { unifiedDiff } from './diff.ts';
import { displayPath, resolvePath } from './fs-paths.ts';
import { object, requireString, str } from './schema.ts';
import { defineTool, type Tool, text } from './types.ts';

interface WriteInput {
  path: string;
  content: string;
}

export const writeTool: Tool<WriteInput> = defineTool<WriteInput>({
  name: 'write',
  description:
    'Write a file, creating it or replacing its entire contents. Prefer `edit` for ' +
    'changes to an existing file; this tool discards everything it does not repeat.',
  readOnly: false,
  inputSchema: object(
    {
      path: str('Path to the file, absolute or relative to the working directory.'),
      content: str('The complete new contents of the file.'),
    },
    ['path', 'content'],
  ),
  parse: (input) => ({
    path: requireString(input, 'path'),
    content: requireString(input, 'content'),
  }),
  permission(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, abs);
    // Synchronous by necessity: the gate runs before execute, and the prompt must
    // show a real diff. A file that cannot be read is a creation, which diffs
    // against the empty string and renders as an all-additions hunk.
    const before = readTextSync(abs);
    return {
      tool: 'Write',
      target: shown,
      title: `${before === undefined ? 'create' : 'overwrite'} ${shown}`,
      detail: unifiedDiff(shown, before ?? '', input.content) || '(no change)',
      writes: [abs],
    };
  },
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    await mkdir(dirname(abs), { recursive: true });
    const before = await readFile(abs, 'utf8').catch(() => undefined);
    await writeFile(abs, input.content, 'utf8');
    ctx.markRead(abs);
    const lines = input.content === '' ? 0 : input.content.split('\n').length;
    return {
      output: text(
        `${before === undefined ? 'created' : 'wrote'} ${displayPath(ctx.cwd, abs)} (${lines} lines)`,
      ),
      title: displayPath(ctx.cwd, abs),
    };
  },
});

/** `undefined` rather than throwing: an unreadable path is a file creation. */
function readTextSync(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
