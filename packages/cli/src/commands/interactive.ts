import {
  createSession,
  isPermissionMode,
  MissingCredentialsError,
  NoSessionToResumeError,
  type PermissionMode,
  UnknownModelError,
} from '@earshot/core';
import { runOnboarding, runTui } from '@earshot/tui';
import type { ParsedArgs } from '../args.ts';
import { parseCuriosity, parseMaxCost } from '../budget.ts';
import { startExtensions } from '../extensions/index.ts';
import { loadImage } from '../image.ts';
import { buildOnboardingOptions } from '../onboard.ts';

const DEFAULT_MODEL = 'anthropic/claude-opus-5';

/**
 * The default command: the interactive TUI.
 *
 * Refuses to start without a TTY rather than rendering into a pipe. Ink would
 * happily draw frames into a redirect and produce a file full of escape
 * sequences; someone piping earshot almost certainly wanted `-p`, and the error
 * says so.
 */
export async function interactiveCommand(args: ParsedArgs): Promise<number> {
  const flags = args.flags;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'earshot needs an interactive terminal. For scripted use, run `earshot -p "<prompt>"`.\n',
    );
    return 2;
  }

  let mode: PermissionMode | undefined;
  const requested = flags['permission-mode'];
  if (typeof requested === 'string') {
    if (!isPermissionMode(requested)) {
      process.stderr.write(`"${requested}" is not a permission mode\n`);
      return 2;
    }
    mode = requested;
  }

  // A bare `earshot "do the thing"` starts the TUI with that first turn already
  // running, which is how most sessions actually begin.
  const initialPrompt = args.positionals.join(' ').trim();
  let image: Awaited<ReturnType<typeof loadImage>> | undefined;
  if (typeof flags.image === 'string') {
    try {
      image = await loadImage(flags.image, process.cwd());
    } catch (error) {
      process.stderr.write(`image: ${(error as Error).message}\n`);
      return 2;
    }
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

  const extensions = await startExtensions(process.cwd());
  const model = typeof flags.model === 'string' ? flags.model : DEFAULT_MODEL;
  // `--no-onboarding` is for CI and for anyone who wants the old dead-end back.
  const onboardingAllowed = flags['no-onboarding'] !== true;

  let firstPrompt = initialPrompt;
  let attempted = false;

  for (;;) {
    try {
      const session = await createSession({
        cwd: process.cwd(),
        extraTools: extensions.tools,
        problems: extensions.problems,
        onDispose: () => extensions.close(),
        model,
        ...(mode ? { mode } : {}),
        ...(typeof flags['api-key'] === 'string' ? { apiKey: flags['api-key'] } : {}),
        ...(curiosity ? { curiosity } : {}),
        ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
        ...resumeFrom(flags),
      });

      return await runTui({
        session,
        model,
        ...(firstPrompt !== '' || image
          ? {
              initialPrompt: image
                ? [...(firstPrompt ? [{ type: 'text' as const, text: firstPrompt }] : []), image]
                : firstPrompt,
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof MissingCredentialsError && onboardingAllowed && !attempted) {
        // Only ever offered once: a second `MissingCredentialsError` after
        // onboarding said it stored working credentials means something else is
        // wrong, and looping back into the same screens would hide that.
        attempted = true;
        const result = await runOnboarding(await buildOnboardingOptions(error.provider.id));
        if (result.outcome === 'quit') {
          process.stdout.write(
            'nothing was stored. run `earshot auth login <provider>` when you are ready.\n',
          );
          await extensions.close();
          return 0;
        }
        firstPrompt = result.firstPrompt ?? firstPrompt;
        continue;
      }
      // The session never reached dispose(), so anything already spawned is
      // ours to clean up here or it outlives the process that started it.
      await extensions.close();
      if (error instanceof UnknownModelError) {
        process.stderr.write(
          `${error.message}\n\nrun \`earshot models\` to see what is available\n`,
        );
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
      throw error;
    }
  }
}

function resumeFrom(flags: ParsedArgs['flags']) {
  if (typeof flags.resume === 'string') return { resume: { path: flags.resume } } as const;
  if (flags.continue === true || flags.resume === true)
    return { resume: { latest: true } } as const;
  return {};
}
