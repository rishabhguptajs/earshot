import {
  createSession,
  EmptyPoolError,
  isPermissionMode,
  MissingCredentialsError,
  NoSessionToResumeError,
  type PermissionMode,
  UnknownModelError,
} from '@earshot/core';
import type { ReasoningEffort } from '@earshot/providers';
import { runOnboarding, runPoolSetup, runTui } from '@earshot/tui';
import type { ParsedArgs } from '../args.ts';
import { parseCuriosity, parseMaxCost } from '../budget.ts';
import { startExtensions } from '../extensions/index.ts';
import { loadImage } from '../image.ts';
import { buildOnboardingOptions } from '../onboard.ts';
import { buildPoolBinding, buildPoolSetupOptions } from '../pool-onboard.ts';

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
  let model = typeof flags.model === 'string' ? flags.model : undefined;
  let reasoningEffort = parseReasoningEffort(flags['reasoning-effort']);
  if (reasoningEffort === 'invalid') {
    process.stderr.write(`"${flags['reasoning-effort']}" is not a reasoning effort\n`);
    return 2;
  }
  // `--no-onboarding` is for CI and for anyone who wants the old dead-end back.
  const onboardingAllowed = flags['no-onboarding'] !== true;

  let attempted = false;

  for (;;) {
    try {
      const session = await createSession({
        cwd: process.cwd(),
        extraTools: extensions.tools,
        problems: extensions.problems,
        onDispose: () => extensions.close(),
        ...(model ? { model } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(mode ? { mode } : {}),
        ...(typeof flags['api-key'] === 'string' ? { apiKey: flags['api-key'] } : {}),
        ...(curiosity ? { curiosity } : {}),
        ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
        ...resumeFrom(flags),
      });

      const tui = await runTui({
        session,
        model: `${session.agent.model.provider.id}/${session.agent.model.model.id}`,
        modelOptions: await buildOnboardingOptions(),
        poolOptions: await buildPoolBinding(process.cwd()),
        ...(initialPrompt !== '' || image
          ? {
              initialPrompt: image
                ? [
                    ...(initialPrompt ? [{ type: 'text' as const, text: initialPrompt }] : []),
                    image,
                  ]
                : initialPrompt,
            }
          : {}),
      });
      if (tui.resumePath) {
        return interactiveCommand({
          command: undefined,
          flags: { ...flags, resume: tui.resumePath, continue: false },
          positionals: [],
        });
      }
      return tui.exitCode;
    } catch (error) {
      const needsSetup =
        error instanceof MissingCredentialsError || error instanceof EmptyPoolError;
      if (needsSetup && onboardingAllowed && !attempted) {
        // Only ever offered once: a second failure after setup said it stored
        // working credentials means something else is wrong, and looping back
        // into the same screens would hide that.
        attempted = true;

        // The free pool is offered first because it is the better answer for
        // most people arriving here: several free tiers pooled outlast any one
        // of them, and it costs nothing to find out.
        const choice = await askHowToStart();
        if (choice === 'quit') {
          await extensions.close();
          return 0;
        }
        if (choice === 'pool') {
          const pooled = await runPoolSetup(await buildPoolSetupOptions(process.cwd()));
          if (pooled.connected > 0) {
            model = undefined;
            continue;
          }
          // Nothing connected - fall through to the single-provider screens
          // rather than dead-ending on a wizard they just declined.
        }

        const wanted = error instanceof MissingCredentialsError ? error.provider.id : undefined;
        const result = await runOnboarding(await buildOnboardingOptions(wanted, model));
        if (result.outcome === 'quit') {
          process.stdout.write(
            'nothing was stored. run `earshot auth login <provider>` when you are ready.\n',
          );
          await extensions.close();
          return 0;
        }
        if (result.model) {
          model = result.model;
          reasoningEffort = result.reasoningEffort;
          await (await buildOnboardingOptions()).remember?.(
            result.model,
            result.reasoningEffort,
            'global',
          );
        }
        continue;
      }
      // The session never reached dispose(), so anything already spawned is
      // ours to clean up here or it outlives the process that started it.
      await extensions.close();
      if (error instanceof EmptyPoolError) {
        process.stderr.write(`${error.message}\n`);
        return 3;
      }
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

function parseReasoningEffort(
  value: string | boolean | undefined,
): ReasoningEffort | null | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return 'invalid';
  return ['none', 'low', 'medium', 'high', 'xhigh'].includes(value)
    ? (value as ReasoningEffort)
    : value === 'auto'
      ? null
      : 'invalid';
}

function resumeFrom(flags: ParsedArgs['flags']) {
  if (typeof flags.resume === 'string') return { resume: { path: flags.resume } } as const;
  if (flags.continue === true || flags.resume === true)
    return { resume: { latest: true } } as const;
  return {};
}

/**
 * The first thing a new user is asked.
 *
 * Deliberately two words of explanation and one keypress: someone who has just
 * installed a coding agent wants to use it, and a screen that explains provider
 * economics before letting them type is a screen they close.
 */
async function askHowToStart(): Promise<'pool' | 'own' | 'quit'> {
  process.stdout.write(
    '\nearshot needs a model before it can do anything.\n\n' +
      '  1  connect free providers  (recommended - several free tiers, pooled)\n' +
      '  2  use my own api key\n\n' +
      'choose [1/2, or q to quit]: ',
  );

  // Line mode, not raw: Ink has not started yet, and putting the terminal into
  // raw mode here would leave it there if the process died before Ink restored
  // it. One extra Return is a cheaper trade than a wedged terminal.
  const answer = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(chunk.toString('utf8').trim().toLowerCase());
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
  process.stdout.write('\n');

  if (answer === 'q') return 'quit';
  return answer === '2' ? 'own' : 'pool';
}
