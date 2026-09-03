import { arr, object, opt, requireArray, requireString, str } from './schema.ts';
import { defineTool, type Tool, ToolInputError, text } from './types.ts';

interface AskUserInput {
  question: string;
  options?: string[];
}

/**
 * The tool the whole "actually listens" premise rests on: the model asks rather
 * than guessing. It is read-only in the permission sense - it changes nothing and
 * must never itself be gated, because a prompt asking permission to ask a question
 * is precisely the friction that trains people to stop reading prompts.
 */
export const askUserTool: Tool<AskUserInput> = defineTool<AskUserInput>({
  name: 'ask_user',
  description:
    'Ask the user a question and wait for their answer. Use this when the request ' +
    'is ambiguous in a way that would change what you build, rather than guessing ' +
    'and building the wrong thing. Do not use it for choices with an obvious ' +
    'default, or to ask permission for an action - that is handled separately.',
  readOnly: true,
  inputSchema: object(
    {
      question: str('The question, specific enough to answer in one line.'),
      options: arr(str('One choice.'), 'Suggested answers. The user may ignore them.'),
    },
    ['question'],
  ),
  parse: (input) => {
    const question = requireString(input, 'question');
    if (question.trim() === '') throw new ToolInputError('"question" must not be empty');
    const raw = (input as Record<string, unknown>).options;
    const options =
      raw === undefined || raw === null
        ? undefined
        : requireArray(input, 'options').map((option, i) => {
            if (typeof option !== 'string')
              throw new ToolInputError(`option ${i + 1} must be a string`);
            return option;
          });
    return { question, ...opt('options', options) };
  },
  async execute(input, ctx) {
    const answer = await ctx.ask(input.question, input.options);
    return { output: text(answer), title: input.question };
  },
});
