import {
  MissingCredentialsError,
  resolveModel,
  streamModel,
  turnCost,
  UnknownModelError,
} from '@earshot/core';
import { buildRegistry, type Message, type Usage } from '@earshot/providers';
import type { ParsedArgs } from '../args.ts';

const DEFAULT_MODEL = 'anthropic/claude-opus-5';

/**
 * `earshot -p "<prompt>"` - one non-interactive turn.
 *
 * No tools yet: this is the seam that proves the provider layer end to end, and
 * the agent loop will replace the single call with a tool-calling loop.
 */
export async function headlessCommand(prompt: string, args: ParsedArgs): Promise<number> {
  const registry = buildRegistry();
  const ref = typeof args.flags.model === 'string' ? args.flags.model : DEFAULT_MODEL;
  const format =
    typeof args.flags['output-format'] === 'string' ? args.flags['output-format'] : 'text';

  let resolved: Awaited<ReturnType<typeof resolveModel>>;
  try {
    resolved = await resolveModel(registry, ref);
  } catch (error) {
    if (error instanceof UnknownModelError) {
      process.stderr.write(`${error.message}\n\nrun \`earshot models\` to see what is available\n`);
      return 2;
    }
    if (error instanceof MissingCredentialsError) {
      process.stderr.write(`${error.message}\n`);
      return 3;
    }
    throw error;
  }

  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);

  let text = '';
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let failed: string | undefined;

  try {
    for await (const event of streamModel(registry, resolved, {
      messages,
      abortSignal: controller.signal,
    })) {
      switch (event.type) {
        case 'text_delta':
          text += event.text;
          if (format === 'text') process.stdout.write(event.text);
          if (format === 'stream-json') {
            process.stdout.write(`${JSON.stringify({ type: 'text_delta', text: event.text })}\n`);
          }
          break;
        case 'finish':
          usage = event.usage;
          break;
        case 'error':
          failed = event.error.message;
          break;
        default:
          break;
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }

  if (failed) {
    process.stderr.write(`${failed}\n`);
    return 1;
  }

  if (format === 'text') process.stdout.write('\n');
  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          text,
          model: `${resolved.provider.id}/${resolved.model.id}`,
          usage,
          costUsd: turnCost(resolved.model, usage),
        },
        null,
        2,
      )}\n`,
    );
  }
  return 0;
}
