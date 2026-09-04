import {
  arr,
  num,
  object,
  opt,
  optionalNumber,
  requireArray,
  requireString,
  str,
} from './schema.ts';
import { defineTool, type Tool, ToolInputError, text } from './types.ts';

interface DeclareScopeInput {
  files: string[];
  intent: string;
  estimatedLines?: number;
}

/**
 * The agent writes down what it is about to change, before it changes anything.
 *
 * Read-only in the permission sense - it touches nothing - but it is the thing
 * the scope guard measures every later edit against, so a turn that skips it
 * gets no guard at all. The system prompt asks for it; the guard is what makes
 * the asking mean something.
 */
export const declareScopeTool: Tool<DeclareScopeInput> = defineTool<DeclareScopeInput>({
  name: 'declare_scope',
  description:
    'State the scope of the change you are about to make, before your first edit or ' +
    'command that changes anything. List the files you expect to touch and say in one ' +
    'paragraph what changes and what does not. Editing a file you did not list, adding a ' +
    'dependency, renaming or deleting files, reformatting, or a change several times ' +
    'larger than your estimate will stop and ask the user. Call it again if the work ' +
    'turns out to be genuinely bigger than you thought.',
  readOnly: true,
  inputSchema: object(
    {
      files: arr(
        str('A path or glob relative to the working directory.'),
        'Files you will change.',
      ),
      intent: str('One paragraph: which behaviours change, and which explicitly do not.'),
      estimated_lines: num('Rough number of lines you expect to add and remove in total.'),
    },
    ['files', 'intent'],
  ),
  parse: (input) => {
    const intent = requireString(input, 'intent');
    if (intent.trim() === '') throw new ToolInputError('"intent" must not be empty');
    const files = requireArray(input, 'files').map((file, i) => {
      if (typeof file !== 'string') throw new ToolInputError(`file ${i + 1} must be a string`);
      return file;
    });
    if (files.length === 0) throw new ToolInputError('"files" must name at least one file');
    return { files, intent, ...opt('estimatedLines', optionalNumber(input, 'estimated_lines')) };
  },
  async execute(input, ctx) {
    ctx.scope.declare({
      files: input.files,
      intent: input.intent,
      ...opt('estimatedLines', input.estimatedLines),
    });
    return {
      output: text(
        `scope recorded: ${input.files.join(', ')}. Anything outside it will ask the user first.`,
      ),
      title: `scope: ${input.files.join(', ')}`,
    };
  },
});
