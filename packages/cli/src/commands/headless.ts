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
import type { ReasoningEffort } from '@earshot/providers';
import type { ParsedArgs } from '../args.ts';
import { parseCuriosity, parseMaxCost } from '../budget.ts';
import { startExtensions } from '../extensions/index.ts';
import { loadImage } from '../image.ts';
import {
  type OutputFormat,
  parseFormat,
  type ResultRecord,
  SCHEMA,
  toStreamRecord,
} from '../output.ts';

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
  const requestedFormat =
    typeof flags['output-format'] === 'string' ? flags['output-format'] : 'text';
  const format = parseFormat(requestedFormat);
  if (!format) {
    // Refused rather than falling back to text: a script asking for a format
    // earshot does not have wants to know that, not to be handed prose.
    process.stderr.write(
      `"${requestedFormat}" is not an output format. Use text, json or stream-json ` +
        `(optionally pinned as json@v1).\n`,
    );
    return 2;
  }
  const emit = makeEmitter(format);
  const startedAt = Date.now();

  let mode: PermissionMode | undefined;
  const requested = flags['permission-mode'];
  if (typeof requested === 'string') {
    if (!isPermissionMode(requested)) {
      process.stderr.write(`"${requested}" is not a permission mode\n`);
      return 2;
    }
    mode = requested;
  }

  const curiosity = parseCuriosity(flags.curiosity);
  if (curiosity === 'invalid') {
    process.stderr.write(`"${flags.curiosity}" is not a curiosity level: low, normal or high\n`);
    return 2;
  }
  const maxCostUsd = parseMaxCost(flags['max-cost']);
  if (maxCostUsd === 'invalid') {
    process.stderr.write(`"${flags['max-cost']}" is not an amount in dollars\n`);
    return 2;
  }
  const reasoningEffort = parseReasoningEffort(flags['reasoning-effort']);
  if (reasoningEffort === 'invalid') {
    process.stderr.write(`"${flags['reasoning-effort']}" is not a reasoning effort\n`);
    return 2;
  }

  const extensions = await startExtensions(process.cwd());

  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    session = await createSession({
      cwd: process.cwd(),
      extraTools: extensions.tools,
      problems: extensions.problems,
      onDispose: () => extensions.close(),
      ...(typeof flags.model === 'string' ? { model: flags.model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(mode ? { mode } : {}),
      ...(typeof flags['api-key'] === 'string' ? { apiKey: flags['api-key'] } : {}),
      ...(curiosity ? { curiosity } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...resumeFrom(flags),
    });
  } catch (error) {
    await extensions.close();
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
  let subtype: ResultRecord['subtype'] = 'success';
  let failure: { kind: string; message: string } | undefined;

  try {
    let image: Awaited<ReturnType<typeof loadImage>> | undefined;
    if (typeof flags.image === 'string') {
      try {
        image = await loadImage(flags.image, process.cwd());
      } catch (error) {
        process.stderr.write(`image: ${(error as Error).message}\n`);
        exitCode = 2;
        subtype = 'error';
        failure = { kind: 'invalid_image', message: (error as Error).message };
      }
    }
    const input = image ? [{ type: 'text' as const, text: prompt }, image] : prompt;
    for await (const event of failure
      ? ([] as AgentEvent[])
      : session.agent.runTurn(input, controller.signal)) {
      emit(event);
      if (event.type === 'error') {
        exitCode = 1;
        subtype = 'error';
        failure = { kind: event.error.kind, message: event.error.message };
      }
      if (event.type === 'turn_end' && event.reason === 'aborted') {
        exitCode = 130;
        subtype = 'interrupted';
      }
      if (event.type === 'turn_end' && event.reason === 'max_steps') {
        exitCode = 1;
        subtype = 'max_steps';
      }
      // Its own exit code: a script that set a ceiling needs to tell "stopped
      // because it ran out of budget" from "stopped because it failed".
      if (event.type === 'turn_end' && event.reason === 'budget') {
        exitCode = 3;
        subtype = 'budget';
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    await session.dispose();
  }

  if (format === 'text') {
    process.stdout.write('\n');
    return exitCode;
  }

  // The same record ends a stream and stands alone as the whole of `json`, so a
  // consumer that reads only the last line of a stream and one that parses a
  // single object are reading the same thing.
  const result: ResultRecord = {
    schema: SCHEMA,
    type: 'result',
    subtype,
    isError: subtype !== 'success',
    text: emit.text(),
    costUsd: session.agent.costUsd,
    durationMs: Date.now() - startedAt,
    numMessages: session.agent.history.length,
    model: `${session.agent.model.provider.id}/${session.agent.model.model.id}`,
    permissionMode: session.agent.permissionMode,
    ...(session.store ? { sessionId: session.store.id } : {}),
    ...(failure ? { error: failure } : {}),
  };
  process.stdout.write(
    format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`,
  );

  return exitCode;
}

function parseReasoningEffort(
  value: string | boolean | undefined,
): ReasoningEffort | null | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto') return null;
  if (typeof value !== 'string') return 'invalid';
  return ['none', 'low', 'medium', 'high', 'xhigh'].includes(value)
    ? (value as ReasoningEffort)
    : 'invalid';
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
function makeEmitter(format: OutputFormat) {
  let text = '';

  const emit = (event: AgentEvent): void => {
    if (event.type === 'text_delta') text += event.text;

    if (format === 'stream-json') {
      const record = toStreamRecord(event);
      if (record) process.stdout.write(`${JSON.stringify(record)}\n`);
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
      case 'hook':
        // A hook that stopped something is why the run did what it did; leaving
        // it out would make the transcript unexplainable.
        if (event.blocked)
          process.stderr.write(`\n${event.event} hook blocked: ${event.blocked}\n`);
        for (const problem of event.problems) process.stderr.write(`  ! ${problem}\n`);
        break;
      case 'subagent':
        process.stderr.write(`\n· subagent "${event.description}" (${event.steps} steps)\n`);
        break;
      case 'error':
        process.stderr.write(`\nerror: ${event.error.message}\n`);
        break;
      case 'turn_end':
        if (event.reason === 'aborted') process.stderr.write('\ninterrupted\n');
        if (event.reason === 'max_steps') process.stderr.write('\nstopped: step limit reached\n');
        if (event.reason === 'budget') process.stderr.write('\nstopped: cost budget reached\n');
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
