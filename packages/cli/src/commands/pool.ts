import { loadSettings, persistPool } from '@earshot/core';
import {
  AuthStore,
  buildRegistry,
  DEFAULT_ACCOUNT,
  FREE_TIERS,
  freeTier,
  LOCAL_TIERS,
  POOL_TIERS,
  poolCandidates,
  QuotaLedger,
} from '@earshot/providers';
import type { ParsedArgs } from '../args.ts';

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

  if (action === 'status') return status(cwd);
  if (action === 'enable') return toggle(cwd, true);
  if (action === 'disable') return toggle(cwd, false);
  if (action === 'add-endpoint') return addEndpoint(cwd, args);
  if (action === 'forget') return forget(args);

  process.stderr.write(
    `earshot pool: unknown action "${action}".\n` +
      'usage: earshot pool <status|enable|disable|add-endpoint|forget>\n',
  );
  return 2;
}

/**
 * What is connected, what is left, and when the spent ones come back.
 *
 * Cost stops being the meaningful number in a pooled session - everything in it
 * is free - so quota is the budget, and this is where you read it.
 */
async function status(cwd: string): Promise<number> {
  const settings = await loadSettings(cwd);
  const store = new AuthStore();
  const ledger = new QuotaLedger();
  const buckets = await ledger.read();
  const now = Date.now();
  const out: string[] = [];

  out.push(settings.pool.enabled ? 'pool: on' : 'pool: off  (earshot pool enable)');
  if (settings.pool.excludeTrainingProviders) {
    out.push('excluding providers that train on submitted data');
  }
  out.push('');

  let connected = 0;
  for (const tier of FREE_TIERS) {
    const local = LOCAL_TIERS.has(tier.providerId);
    const accounts = await store.listAccounts(tier.providerId);
    if (accounts.length === 0 && !local) {
      out.push(`${tier.providerId.padEnd(16)} ${'-'.padEnd(30)} not connected`);
      continue;
    }
    if (local) {
      out.push(`${tier.providerId.padEnd(16)} ${'local'.padEnd(30)} no quota`);
      continue;
    }

    for (const account of accounts) {
      connected++;
      const key = `${tier.providerId}#${account.account}`;
      const bucket = buckets[key];
      const label =
        account.account === DEFAULT_ACCOUNT
          ? tier.providerId
          : `${tier.providerId}#${account.account}`;
      out.push(
        `${label.padEnd(16)} ${spend(bucket, tier.limits).padEnd(30)} ${when(bucket, now)}` +
          (tier.trainsOnData ? '  · trains on your data' : ''),
      );
    }
  }

  if (connected === 0) {
    out.push('', 'nothing is connected yet. run `earshot pool setup` to add a free provider.');
  } else {
    // Which concrete model each tier resolves to right now is the question
    // "what am I actually running on?", and it is not answerable from the table.
    const registry = buildRegistry();
    out.push('');
    for (const tier of POOL_TIERS) {
      const candidates = await poolCandidates(registry, tier, { store });
      const first = candidates[0];
      out.push(
        `free/${tier.padEnd(6)} ${first ? `${first.provider.id}/${first.model.id}` : 'nothing available'}` +
          (candidates.length > 1 ? `  (+${candidates.length - 1} more)` : ''),
      );
    }
  }

  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

function spend(
  bucket: { minute: { requests: number }; day: { requests: number } } | undefined,
  limits: { rpm?: number; rpd?: number },
): string {
  const day = bucket?.day.requests ?? 0;
  const minute = bucket?.minute.requests ?? 0;
  const perDay = limits.rpd ? `${day}/${limits.rpd} today` : `${day} today`;
  return limits.rpm ? `${perDay}, ${minute}/${limits.rpm} this min` : perDay;
}

function when(bucket: { cooldownUntil?: number } | undefined, now: number): string {
  const until = bucket?.cooldownUntil;
  if (!until || until <= now) return 'ready';
  const minutes = Math.ceil((until - now) / 60_000);
  return `rate limited, back in ${minutes}m`;
}

async function toggle(cwd: string, enabled: boolean): Promise<number> {
  const path = await persistPool({ enabled }, 'global', cwd);
  process.stdout.write(`pool ${enabled ? 'enabled' : 'disabled'} in ${path}\n`);
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
