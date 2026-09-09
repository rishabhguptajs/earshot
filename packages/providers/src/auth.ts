import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { authFile } from './paths.ts';
import type { AuthSpec, Credentials, Provider } from './types.ts';

/**
 * One credential, named.
 *
 * Free tiers meter per *account*, not per key: a second key minted inside the
 * same account draws down the same bucket. Naming them is what lets the pool
 * keep one quota ledger per account and tell the user which of theirs is spent.
 */
export interface Account extends Credentials {
  /** Unique within a provider. `default` is the one a bare provider id means. */
  account: string;
}

export const DEFAULT_ACCOUNT = 'default';

/**
 * A v1 file stores one `Credentials` per provider; v2 stores a named list. Both
 * shapes are read, because v1 files exist on disk right now and a user who
 * never touches the pool should never see their file rewritten.
 */
type StoredProvider = Credentials | { accounts: Account[] };
type AuthFileShape = { version: 1 | 2; providers: Record<string, StoredProvider> };

function accountsOf(stored: StoredProvider | undefined): Account[] {
  if (!stored) return [];
  if ('accounts' in stored) return stored.accounts;
  return [{ ...stored, account: DEFAULT_ACCOUNT }];
}

/**
 * Credential store. On-disk file is 0600 and written atomically; OAuth refreshes
 * take a lock file so two concurrent earshot processes cannot clobber each other.
 */
export class AuthStore {
  #path: string;
  #cache: AuthFileShape | undefined;

  constructor(path = authFile()) {
    this.#path = path;
  }

  async #load(): Promise<AuthFileShape> {
    if (this.#cache) return this.#cache;
    try {
      const raw = await readFile(this.#path, 'utf8');
      const parsed = JSON.parse(raw) as AuthFileShape;
      this.#cache = parsed.providers ? parsed : { version: 1, providers: {} };
    } catch {
      this.#cache = { version: 1, providers: {} };
    }
    return this.#cache;
  }

  /** The default account, or the only one. What every non-pool caller wants. */
  async get(providerId: string): Promise<Credentials | undefined> {
    const accounts = accountsOf((await this.#load()).providers[providerId]);
    return accounts.find((one) => one.account === DEFAULT_ACCOUNT) ?? accounts[0];
  }

  async set(providerId: string, creds: Credentials): Promise<void> {
    return this.setAccount(providerId, DEFAULT_ACCOUNT, creds);
  }

  /** Forgets every account for a provider - what `auth logout <provider>` means. */
  async remove(providerId: string): Promise<void> {
    const data = await this.#load();
    delete data.providers[providerId];
    await this.#flush(data);
  }

  async listAccounts(providerId: string): Promise<Account[]> {
    return accountsOf((await this.#load()).providers[providerId]);
  }

  /** Every provider that has at least one credential, with its account names. */
  async list(): Promise<Array<{ providerId: string; accounts: Account[] }>> {
    const data = await this.#load();
    return Object.keys(data.providers).map((providerId) => ({
      providerId,
      accounts: accountsOf(data.providers[providerId]),
    }));
  }

  async setAccount(providerId: string, account: string, creds: Credentials): Promise<void> {
    const data = await this.#load();
    const existing = accountsOf(data.providers[providerId]);
    const next: Account = { ...creds, account };
    const at = existing.findIndex((one) => one.account === account);
    if (at >= 0) existing[at] = next;
    else existing.push(next);

    // A lone default stays in the v1 shape: rewriting every user's file to v2
    // the first time they log in would break any older earshot sharing it.
    data.providers[providerId] =
      existing.length === 1 && existing[0]?.account === DEFAULT_ACCOUNT
        ? creds
        : { accounts: existing };
    if (existing.length > 1) data.version = 2;
    await this.#flush(data);
  }

  async removeAccount(providerId: string, account: string): Promise<void> {
    const data = await this.#load();
    const kept = accountsOf(data.providers[providerId]).filter((one) => one.account !== account);
    if (kept.length === 0) delete data.providers[providerId];
    else if (kept.length === 1 && kept[0]?.account === DEFAULT_ACCOUNT) {
      const { account: _name, ...creds } = kept[0];
      data.providers[providerId] = creds;
    } else data.providers[providerId] = { accounts: kept };
    await this.#flush(data);
  }

  async #flush(data: AuthFileShape): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.#path);
    this.#cache = data;
  }
}

export interface ResolveAuthOptions {
  /** From `--api-key` or equivalent; highest precedence. */
  cliApiKey?: string;
  env?: NodeJS.ProcessEnv;
  store?: AuthStore;
}

/**
 * Resolution order (plan §Auth resolution):
 * CLI flag -> env var -> auth.json -> provider-native ambient credentials.
 */
export async function resolveCredentials(
  provider: Provider,
  opts: ResolveAuthOptions = {},
): Promise<Credentials | undefined> {
  const env = opts.env ?? process.env;
  if (opts.cliApiKey) return { type: 'api-key', apiKey: opts.cliApiKey };

  for (const name of envVarsOf(provider.auth)) {
    const value = env[name];
    if (value) return { type: 'api-key', apiKey: value };
  }

  const stored = await (opts.store ?? new AuthStore()).get(provider.id);
  if (stored) return stored;

  if (provider.auth.kind === 'ambient' || provider.auth.kind === 'none') {
    return { type: 'ambient' };
  }
  return undefined;
}

function envVarsOf(auth: AuthSpec): string[] {
  return 'envVars' in auth && auth.envVars ? auth.envVars : [];
}
