import { readFile, stat } from 'node:fs/promises';
import { exec, hasExecutable } from './exec.ts';
import { displayPath, resolvePath } from './fs-paths.ts';
import { globToRegExp } from './glob-match.ts';
import {
  bool,
  num,
  object,
  opt,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  str,
} from './schema.ts';
import { defineTool, type Tool, type ToolContext, ToolInputError, text } from './types.ts';
import { loadGitignore, walk } from './walk.ts';

const DEFAULT_LIMIT = 100;
/** Larger files are almost always generated; scanning them rarely pays. */
const MAX_FILE_BYTES = 2_000_000;

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
  ignoreCase?: boolean;
  limit?: number;
}

export const grepTool: Tool<GrepInput> = defineTool<GrepInput>({
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns `path:line:text` for ' +
    'each match. Uses ripgrep when installed and an equivalent in-process search ' +
    'otherwise, so results do not depend on what the machine happens to have.',
  readOnly: true,
  inputSchema: object(
    {
      pattern: str('Regular expression to search for.'),
      path: str('Directory or file to search. Defaults to the working directory.'),
      include: str('Only search files matching this glob, e.g. `*.ts`.'),
      ignoreCase: bool('Match case-insensitively.'),
      limit: num(`Maximum matching lines. Defaults to ${DEFAULT_LIMIT}.`),
    },
    ['pattern'],
  ),
  parse: (input) => ({
    pattern: requireString(input, 'pattern'),
    ...opt('path', optionalString(input, 'path')),
    ...opt('include', optionalString(input, 'include')),
    ...opt('ignoreCase', optionalBoolean(input, 'ignoreCase')),
    ...opt('limit', optionalNumber(input, 'limit')),
  }),
  async execute(input, ctx) {
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    const limit = input.limit ?? DEFAULT_LIMIT;

    // Compiled up front so a bad pattern surfaces as a tool input error the model
    // can fix, rather than as an exit code, and so both back ends reject alike.
    let regexp: RegExp;
    try {
      regexp = new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
    } catch (error) {
      throw new ToolInputError(`invalid regular expression: ${(error as Error).message}`);
    }

    const matches = (await hasExecutable('rg', ctx.cwd))
      ? await ripgrep(input, root, limit, ctx)
      : await jsGrep(input, regexp, root, limit, ctx);

    const where = displayPath(ctx.cwd, root);
    if (matches.length === 0) {
      return { output: text(`no matches for ${input.pattern} in ${where}`), title: input.pattern };
    }
    const capped = matches.slice(0, limit);
    const more =
      matches.length > capped.length ? `\n\n... ${matches.length - capped.length} more` : '';
    return {
      output: text(capped.join('\n') + more),
      title: `${input.pattern} in ${where} (${matches.length} matches)`,
    };
  },
});

async function ripgrep(
  input: GrepInput,
  root: string,
  limit: number,
  ctx: ToolContext,
): Promise<string[]> {
  const args = ['--line-number', '--no-heading', '--color=never', '--max-count', String(limit)];
  if (input.ignoreCase) args.push('--ignore-case');
  if (input.include) args.push('--glob', input.include);
  args.push('--regexp', input.pattern, root);

  const result = await exec('rg', args, { cwd: ctx.cwd, signal: ctx.signal });
  // ripgrep exits 1 for "no matches", which is not a failure; 2 and up are.
  if (result.code !== null && result.code > 1) {
    throw new ToolInputError(result.stderr.trim() || `ripgrep exited ${result.code}`);
  }
  return result.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => relativise(line, root, ctx.cwd));
}

/** ripgrep echoes the absolute root it was given; the model wants project paths. */
function relativise(line: string, root: string, cwd: string): string {
  if (!line.startsWith(root)) return line;
  const rest = line.slice(root.length).replace(/^[/\\]/, '');
  const prefix = displayPath(cwd, root);
  return prefix === '.' || prefix === '' ? rest : `${prefix}/${rest}`;
}

async function jsGrep(
  input: GrepInput,
  regexp: RegExp,
  root: string,
  limit: number,
  ctx: ToolContext,
): Promise<string[]> {
  const include = input.include ? globToRegExp(input.include) : undefined;
  const out: string[] = [];

  const info = await stat(root).catch(() => undefined);
  if (!info) throw new ToolInputError(`no such path: ${displayPath(ctx.cwd, root)}`);

  if (info.isFile()) {
    await scan(root, displayPath(ctx.cwd, root), regexp, out, limit);
    return out;
  }

  const ignore = await loadGitignore(root);
  for await (const entry of walk({ root, ignore, signal: ctx.signal })) {
    if (include && !include.test(entry.rel)) continue;
    if (await scan(entry.path, entry.rel, regexp, out, limit)) break;
  }
  return out;
}

/** Returns true once the limit is exceeded, so the walk can stop early. */
async function scan(
  path: string,
  label: string,
  regexp: RegExp,
  out: string[],
  limit: number,
): Promise<boolean> {
  const content = await readFile(path, 'utf8').catch(() => undefined);
  if (content === undefined || content.length > MAX_FILE_BYTES) return false;
  // A NUL byte near the start is the cheap, conventional binary-file test.
  if (content.slice(0, 1024).includes('\u0000')) return false;

  for (const [i, line] of content.split('\n').entries()) {
    if (!regexp.test(line)) continue;
    out.push(`${label}:${i + 1}:${line.slice(0, 400)}`);
    if (out.length > limit) return true;
  }
  return false;
}
