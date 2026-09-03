import {
  type AgentEvent,
  createSession,
  isPermissionMode,
  MissingCredentialsError,
  NoSessionToResumeError,
  type PermissionMode,
  ShellNotFoundError,
  UnknownModelError,
} from '@earshot/core';
import type { ParsedArgs } from '../args.ts';

const DEFAULT_MODEL = 'anthropic/claude-opus-5';

/**
 * `earshot -p "<prompt>"` - one non-interactive turn, with tools.
 *
 * Headless runs default to `ask` like everywhere else, which with no terminal to
 * prompt at means mutating tools are refused with an explanation the model can
 * act on. Scripted use passes `--permission-mode`; that is a deliberate choice
 * the caller makes, not a default they fall into.
 */
export async function headlessCommand(prompt: string, args: ParsedArgs): Promise<number> {
  const flags = args.flags;
  const format = typeof flags['output-format'] === 'string' ? flags['output-format'] : 'text';
  const emit = makeEmitter(format);

  let mode: PermissionMode | undefined;
  const requested = flags['permission-mode'];
  if (typeof requested === 'string') {
    if (!isPermissionMode(requested)) {
      process.stderr.write(`"${requested}" is not a permission mode\n`);
      return 2;
    }
    mode = requested;
  }

  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    session = await createSession({
      cwd: process.cwd(),
      model: typeof flags.model === 'string' ? flags.model : DEFAULT_MODEL,
      ...(mode ? { mode } : {}),
      ...(typeof flags['api-key'] === 'string' ? { apiKey: flags['api-key'] } : {}),
      ...resumeFrom(flags),
    });
  } catch (error) {
    return reportStartupFailure(error);
  }

  for (const problem of session.problems) process.stderr.write(`warning: ${problem}\n`);

  const controller = new AbortController();
  // A second interrupt exits rather than waiting: the first asks the turn to
  // stop, and a turn wedged in a subprocess should not trap the user.
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) controller.abort();
    else process.exit(130);
  };
  process.on('SIGINT', onSigint);

  let exitCode = 0;
  try {
    for await (const event of session.agent.runTurn(prompt, controller.signal)) {
      emit(event);
      if (event.type === 'error') exitCode = 1;
      if (event.type === 'turn_end' && event.reason === 'aborted') exitCode = 130;
      if (event.type === 'turn_end' && event.reason === 'max_steps') exitCode = 1;
    }
  } finally {
    process.off('SIGINT', onSigint);
    await session.dispose();
  }

  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          text: emit.text(),
          costUsd: session.agent.costUsd,
          messages: session.agent.history.length,
          ...(session.store ? { sessionId: session.store.id } : {}),
        },
        null,
        2,
      )}\n`,
    );
  } else if (format === 'text') {
    process.stdout.write('\n');
  }

  return exitCode;
}

function resumeFrom(flags: ParsedArgs['flags']) {
  if (typeof flags.resume === 'string') return { resume: { path: flags.resume } } as const;
  if (flags.continue === true || flags.resume === true)
    return { resume: { latest: true } } as const;
  return {};
}

/**
 * Renders events for one of three consumers: a person reading a terminal, a
 * script parsing one JSON object, or a program reading a JSON stream. All three
 * see tool activity - a headless run that printed only prose would hide the fact
 * that the agent edited files.
 */
function makeEmitter(format: string) {
  let text = '';

  const emit = (event: AgentEvent): void => {
    if (event.type === 'text_delta') text += event.text;

    if (format === 'stream-json') {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    if (format !== 'text') return;

    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text);
        break;
      case 'tool_start':
        process.stderr.write(`\n· ${event.call.toolName}\n`);
        break;
      case 'tool_end':
        if (event.result.isError) {
          process.stderr.write(`  ! ${describe(event.result.output)}\n`);
        }
        break;
      case 'error':
        process.stderr.write(`\nerror: ${event.error.message}\n`);
        break;
      case 'turn_end':
        if (event.reason === 'aborted') process.stderr.write('\ninterrupted\n');
        if (event.reason === 'max_steps') process.stderr.write('\nstopped: step limit reached\n');
        break;
      default:
        break;
    }
  };

  emit.text = () => text;
  return emit;
}

function describe(output: { type: string; value: unknown }): string {
  return output.type === 'text' ? (String(output.value).split('\n')[0] ?? '') : output.type;
}

function reportStartupFailure(error: unknown): number {
  if (error instanceof UnknownModelError) {
    process.stderr.write(`${error.message}\n\nrun \`earshot models\` to see what is available\n`);
    return 2;
  }
  if (error instanceof MissingCredentialsError) {
    process.stderr.write(`${error.message}\n`);
    return 3;
  }
  if (error instanceof NoSessionToResumeError) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (error instanceof ShellNotFoundError) {
    process.stderr.write(`${error.message}\n`);
    return 4;
  }
  throw error;
}
