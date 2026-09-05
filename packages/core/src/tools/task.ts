import { arr, object, opt, requireString, str } from './schema.ts';
import { defineTool, type Tool, ToolInputError, text } from './types.ts';

export interface TaskInput {
  description: string;
  prompt: string;
  tools?: string[];
}

/**
 * The tools a subagent gets when the caller names none: the ones that only look.
 *
 * A subagent is most often used to search or read something large without
 * spending the parent's context on it, and defaulting to that means the common
 * case cannot change anything at all.
 */
export const DEFAULT_SUBAGENT_TOOLS = ['read', 'ls', 'glob', 'grep', 'ask_user', 'todo'];

/**
 * Runs a sub-task in a nested agent with its own context window.
 *
 * Not read-only: what the subagent does is gated call by call inside it, but
 * starting one is itself worth showing the user, and a subagent that could run
 * concurrently with the parent's own reads would race them.
 */
export const taskTool: Tool<TaskInput> = defineTool<TaskInput>({
  name: 'task',
  description:
    'Run a self-contained sub-task in a nested agent with its own context window, and get ' +
    'back its answer rather than its transcript. Use it for work that would fill this ' +
    'conversation with output you do not need to keep - searching a large codebase, ' +
    'reading a long file to answer one question. The subagent sees none of this ' +
    'conversation, so the prompt must contain everything it needs.',
  readOnly: false,
  inputSchema: object(
    {
      description: str('One short line naming the sub-task, e.g. "find the retry logic".'),
      prompt: str('The whole task. The subagent sees nothing else, so include the context.'),
      tools: arr(
        { type: 'string' },
        'Tool names it may use. Defaults to the read-only ones. Anything here that this ' +
          'session does not already allow is ignored.',
      ),
    },
    ['description', 'prompt'],
  ),
  parse: (input) => {
    const description = requireString(input, 'description');
    const prompt = requireString(input, 'prompt');
    if (prompt.trim() === '') throw new ToolInputError('"prompt" cannot be empty');
    const raw = (input as { tools?: unknown }).tools;
    if (raw !== undefined && !Array.isArray(raw))
      throw new ToolInputError('"tools" must be a list');
    const tools = raw?.map(String);
    return { description, prompt, ...opt('tools', tools) };
  },
  permission: (input) => ({
    tool: 'Task',
    target: input.description,
    title: `run a subagent: ${input.description}`,
    detail:
      `${input.prompt}\n\nTools: ${(input.tools ?? DEFAULT_SUBAGENT_TOOLS).join(', ')}\n\n` +
      "It inherits this session's permission rules and declared scope, and anything it " +
      'does that needs approval will still ask.',
  }),
  async execute(input, ctx) {
    const run = ctx.runSubagent;
    if (!run) {
      throw new ToolInputError('this session cannot run a subagent; do the work here instead');
    }

    const result = await run(
      {
        description: input.description,
        prompt: input.prompt,
        ...opt('tools', input.tools),
      },
      ctx.signal,
    );

    // The subagent's answer, and the fact that it did not finish if it did not.
    // A truncated run reported as a complete answer is the same failure as
    // "done" from a turn whose tests never ran.
    const warning =
      result.stoppedBecause === undefined
        ? ''
        : `\n\n[the subagent stopped early: ${result.stoppedBecause}. Treat this answer as ` +
          'incomplete and say so.]';

    return {
      output: text(`${result.text || '(the subagent produced no answer)'}${warning}`),
      ...(result.stoppedBecause === 'error' ? { isError: true } : {}),
      title: `${input.description} - ${result.steps} step${result.steps === 1 ? '' : 's'}, $${result.costUsd.toFixed(4)}`,
    };
  },
});
