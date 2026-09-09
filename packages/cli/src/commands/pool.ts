import { adoptPoolDefault, loadSettings, POOL_DEFAULT_MODEL, persistPool } from '@earshot/core';
import { AuthStore, freeTier } from '@earshot/providers';
import { runPoolSetup } from '@earshot/tui';
import type { ParsedArgs } from '../args.ts';
import { buildPoolSetupOptions, poolStatusText } from '../pool-onboard.ts';

/**
 * `earshot pool status|enable|disable|add-endpoint|forget`.
 *
 * The pool is the answer to a specific problem: a dozen vendors give away real
 * capacity, and any one of those free tiers is too small to code against. Added
 * together they are not - but only if the user configures them once and never
 * thinks about it again, which is what these commands are in service of.
 *
 * `pool setup` is the interactive wizard and lives in the TUI; everything here
 * is what you can do without one.
 */
export async function poolCommand(args: ParsedArgs): Promise<number> {
  const [action = 'status'] = args.positionals;
  const cwd = process.cwd();

  if (action === 'setup') return setup(cwd);
  if (action === 'status') {
    process.stdout.write(`${await poolStatusText(cwd)}\n`);
    return 0;
  }
  if (action === 'enable') return toggle(cwd, true);
  if (action === 'disable') return toggle(cwd, false);
  if (action === 'add-endpoint') return addEndpoint(cwd, args);
  if (action === 'forget') return forget(args);

  process.stderr.write(
    `earshot pool: unknown action "${action}".\n` +
      'usage: earshot pool <setup|status|enable|disable|add-endpoint|forget>\n',
  );
  return 2;
}

async function setup(cwd: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'earshot pool setup needs an interactive terminal.\n' +
        'for scripts, use `earshot auth login <provider> --api-key <key>` and ' +
        '`earshot pool enable`.\n',
    );
    return 2;
  }

  const result = await runPoolSetup(await buildPoolSetupOptions(cwd));
  if (result.connected === 0) {
    process.stdout.write('nothing was connected. run `earshot pool setup` when you are ready.\n');
    return 0;
  }
  process.stdout.write(
    `${result.connected} free ${result.connected === 1 ? 'account' : 'accounts'} connected. ` +
      'earshot will use free/best - `earshot pool status` shows what is left.\n',
  );
  return 0;
}

/**
 * Enabling also points `defaultModel` at the pool, in every scope that sets one.
 * A project file pinning `openrouter/x` from before the pool existed would
 * otherwise shadow the global `free/best`, and "pool enabled" would change
 * nothing the user could see.
 */
async function toggle(cwd: string, enabled: boolean): Promise<number> {
  if (!enabled) {
    const path = await persistPool({ enabled }, 'global', cwd);
    process.stdout.write(`pool disabled in ${path}\n`);
    return 0;
  }
  const { paths, replaced } = await adoptPoolDefault(POOL_DEFAULT_MODEL, cwd);
  process.stdout.write(`pool enabled in ${paths[0]} - sessions start on ${POOL_DEFAULT_MODEL}\n`);
  for (const one of replaced) {
    process.stdout.write(
      `  ${one.path}: default model was ${one.model}, now ${POOL_DEFAULT_MODEL}\n`,
    );
  }
  return 0;
}

/**
 * earshot ships no unofficial or reverse-engineered providers: they break
 * constantly and can get a user's upstream account banned, and maintaining a
 * list of them is a promise this project should not make. This is the door for
 * anyone who wants one anyway - their endpoint, their call.
 */
async function addEndpoint(cwd: string, args: ParsedArgs): Promise<number> {
  const [, id, baseUrl, ...models] = args.positionals;
  if (!id || !baseUrl || models.length === 0) {
    process.stderr.write(
      'usage: earshot pool add-endpoint <id> <base-url> <model-id>...\n\n' +
        'any OpenAI-compatible endpoint. the key, if it needs one, goes in\n' +
        `an environment variable named after the id, e.g. ${'<ID>'}_API_KEY.\n`,
    );
    return 2;
  }
  if (freeTier(id) || id === 'free') {
    process.stderr.write(`"${id}" is already a provider earshot knows. pick another id.\n`);
    return 2;
  }

  const settings = await loadSettings(cwd);
  const endpoints = (settings.pool.endpoints ?? []).filter((one) => one.id !== id);
  endpoints.push({
    id,
    baseUrl,
    apiKeyEnv: `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
    models: models.map((model) => ({ id: model })),
  });

  const path = await persistPool({ endpoints }, 'global', cwd);
  process.stdout.write(`added ${id} (${models.length} models) to ${path}\n`);
  return 0;
}

async function forget(args: ParsedArgs): Promise<number> {
  const [, target] = args.positionals;
  if (!target) {
    process.stderr.write('usage: earshot pool forget <provider>[#account]\n');
    return 2;
  }
  const [providerId = '', account] = target.split('#');
  const store = new AuthStore();
  if (account) await store.removeAccount(providerId, account);
  else await store.remove(providerId);
  process.stdout.write(`forgot credentials for ${target}\n`);
  return 0;
}
