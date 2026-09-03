import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { unifiedDiff } from './diff.ts';
import { displayPath, resolvePath } from './fs-paths.ts';
import {
  arr,
  bool,
  object,
  opt,
  optionalBoolean,
  requireArray,
  requireString,
  str,
} from './schema.ts';
import { defineTool, type Tool, type ToolContext, ToolInputError, text } from './types.ts';

export interface Replacement {
  find: string;
  replace: string;
  replaceAll?: boolean;
}

interface EditInput extends Replacement {
  path: string;
}

interface MultiEditInput {
  path: string;
  edits: Replacement[];
}

/**
 * Applies exact-string replacements in order, each against the result of the last.
 *
 * A `find` that matches more than once is an error rather than a first-match
 * replacement: the model cannot see which occurrence it hit, so silently picking
 * one is how an edit lands in the wrong function. The fix is for the model to
 * include more surrounding context, which the message says.
 */
export function applyEdits(source: string, edits: Replacement[], label: string): string {
  let out = source;
  for (const [i, edit] of edits.entries()) {
    const where = edits.length > 1 ? ` (edit ${i + 1})` : '';
    if (edit.find === '') throw new ToolInputError(`"find" must not be empty${where}`);
    if (edit.find === edit.replace) {
      throw new ToolInputError(`"find" and "replace" are identical${where}`);
    }

    const count = occurrences(out, edit.find);
    if (count === 0) {
      throw new ToolInputError(
        `"find" does not appear in ${label}${where}. The text must match the file byte for byte, ` +
          'including indentation.',
      );
    }
    if (count > 1 && !edit.replaceAll) {
      throw new ToolInputError(
        `"find" appears ${count} times in ${label}${where}. Include enough surrounding lines to ` +
          'make it unique, or set replaceAll.',
      );
    }
    out = edit.replaceAll
      ? out.split(edit.find).join(edit.replace)
      : out.replace(edit.find, edit.replace);
  }
  return out;
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

function parseReplacement(input: unknown, index?: number): Replacement {
  try {
    return {
      find: requireString(input, 'find'),
      replace: requireString(input, 'replace'),
      ...opt('replaceAll', optionalBoolean(input, 'replaceAll')),
    };
  } catch (error) {
    const where = index === undefined ? '' : ` in edit ${index + 1}`;
    throw new ToolInputError(`${(error as Error).message}${where}`);
  }
}

const replacementSchema = object(
  {
    find: str('Exact text to find, including indentation. Must be unique in the file.'),
    replace: str('Text to replace it with.'),
    replaceAll: bool('Replace every occurrence instead of requiring a unique match.'),
  },
  ['find', 'replace'],
);

function editPermission(cwd: string, path: string, edits: Replacement[], verb: string) {
  const abs = resolvePath(cwd, path);
  const shown = displayPath(cwd, abs);
  let before: string;
  try {
    before = readFileSync(abs, 'utf8');
  } catch {
    throw new ToolInputError(`no such file: ${shown}`);
  }
  // Applied here as well as in execute so the prompt shows the diff that will
  // actually land, and so a non-matching `find` fails before the user is asked.
  const after = applyEdits(before, edits, shown);
  return {
    tool: 'Edit',
    target: shown,
    title: `${verb} ${shown}`,
    detail: unifiedDiff(shown, before, after) || '(no change)',
    writes: [abs],
  };
}

async function runEdits(path: string, edits: Replacement[], ctx: ToolContext) {
  const abs = resolvePath(ctx.cwd, path);
  const shown = displayPath(ctx.cwd, abs);
  if (!ctx.hasRead(abs)) {
    throw new ToolInputError(`read ${shown} before editing it`);
  }
  const before = await readFile(abs, 'utf8');
  const after = applyEdits(before, edits, shown);
  await writeFile(abs, after, 'utf8');
  const changed = unifiedDiff(shown, before, after);
  return {
    output: text(changed === '' ? `${shown} was already in the requested state` : changed),
    title: shown,
  };
}

export const editTool: Tool<EditInput> = defineTool<EditInput>({
  name: 'edit',
  description:
    'Replace an exact string in a file. The file must have been read first, and ' +
    '`find` must appear exactly once unless replaceAll is set.',
  readOnly: false,
  inputSchema: object(
    {
      path: str('Path to the file, absolute or relative to the working directory.'),
      find: str('Exact text to find, including indentation. Must be unique in the file.'),
      replace: str('Text to replace it with.'),
      replaceAll: bool('Replace every occurrence instead of requiring a unique match.'),
    },
    ['path', 'find', 'replace'],
  ),
  parse: (input) => ({ path: requireString(input, 'path'), ...parseReplacement(input) }),
  permission: (input, ctx) => editPermission(ctx.cwd, input.path, [input], 'edit'),
  execute: (input, ctx) => runEdits(input.path, [input], ctx),
});

export const multiEditTool: Tool<MultiEditInput> = defineTool<MultiEditInput>({
  name: 'multi_edit',
  description:
    'Apply several exact-string replacements to one file, in order, each against ' +
    'the result of the last. All succeed or none are written.',
  readOnly: false,
  inputSchema: object(
    {
      path: str('Path to the file, absolute or relative to the working directory.'),
      edits: arr(replacementSchema, 'Replacements to apply in order.'),
    },
    ['path', 'edits'],
  ),
  parse: (input) => {
    const edits = requireArray(input, 'edits').map((edit, i) => parseReplacement(edit, i));
    if (edits.length === 0) throw new ToolInputError('"edits" must not be empty');
    return { path: requireString(input, 'path'), edits };
  },
  permission: (input, ctx) =>
    editPermission(ctx.cwd, input.path, input.edits, `apply ${input.edits.length} edits to`),
  execute: (input, ctx) => runEdits(input.path, input.edits, ctx),
});
