import {
  AuthStore,
  buildRegistry,
  loginToOpenRouter,
  OAuthError,
  resolveCredentials,
} from '@earshot/providers';
import type { ParsedArgs } from '../args.ts';

/**
 * `earshot auth login|list|logout`.
 *
 * `login` prompts for a key by default; a provider with a published OAuth flow
 * for third-party apps can be signed into instead. Nothing here uses a
 * consumer subscription's credentials outside the client it was issued for -
 * see docs/providers.md, "Deliberately not supported".
 */
export async function authCommand(args: ParsedArgs): Promise<number> {
  const [action = 'list', providerId] = args.positionals;

  if (action === 'list') return list();
  if (action === 'login') return login(providerId, args);
  if (action === 'logout') return logout(providerId);

  process.stderr.write(`earshot auth: unknown action "${action}"\n`);
  return 2;
}

async function list(): Promise<number> {
  const registry = buildRegistry();
  const rows: string[] = [];

  for (const provider of registry.list()) {
    const credentials = await resolveCredentials(provider).catch(() => undefined);
    const how =
      credentials === undefined
        ? 'not configured'
        : credentials.type === 'ambient'
          ? 'ambient credentials'
          : credentials.type === 'oauth'
            ? 'signed in'
            : 'api key';
    rows.push(`${provider.id.padEnd(14)} ${how}`);
  }

  process.stdout.write(`${rows.join('\n')}\n`);
  return 0;
}

async function login(providerId: string | undefined, args: ParsedArgs): Promise<number> {
  if (!providerId) {
    process.stderr.write('usage: earshot auth login <provider> [--api-key <key>]\n');
    return 2;
  }

  const store = new AuthStore();
  const key = args.flags['api-key'];
  if (typeof key === 'string' && key !== '') {
    await store.set(providerId, { type: 'api-key', apiKey: key });
    process.stdout.write(`stored an api key for ${providerId}\n`);
    return 0;
  }

  if (providerId !== 'openrouter') {
    process.stderr.write(
      `earshot has no sign-in flow for "${providerId}". Pass --api-key, or set its ` +
        'environment variable - `earshot models` names it.\n',
    );
    return 2;
  }

  try {
    const credentials = await loginToOpenRouter({
      onUrl: (url) => {
        // Printed as well as opened: over SSH or in a container there is no
        // browser to open, and a flow that only opens one leaves nothing to do.
        process.stdout.write(`opening your browser to sign in to OpenRouter.\n\n${url}\n\n`);
      },
    });
    await store.set(providerId, credentials);
    process.stdout.write('signed in to OpenRouter.\n');
    return 0;
  } catch (error) {
    if (error instanceof OAuthError) {
      process.stderr.write(`${error.message}\n`);
      return 3;
    }
    process.stderr.write(`sign-in failed: ${(error as Error).message}\n`);
    return 3;
  }
}

async function logout(providerId: string | undefined): Promise<number> {
  if (!providerId) {
    process.stderr.write('usage: earshot auth logout <provider>\n');
    return 2;
  }
  await new AuthStore().remove(providerId);
  // Says what it did not do: a key in the environment outlives this, and a user
  // who thinks they logged out and did not is worse off than one who knows.
  process.stdout.write(
    `removed stored credentials for ${providerId}. An environment variable, if you have ` +
      'one set, still applies.\n',
  );
  return 0;
}
