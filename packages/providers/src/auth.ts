import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { authFile } from './paths.ts';
import type { AuthSpec, Credentials, Provider } from './types.ts';

type AuthFileShape = { version: 1; providers: Record<string, Credentials> };

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

  async get(providerId: string): Promise<Credentials | undefined> {
    return (await this.#load()).providers[providerId];
  }

  async set(providerId: string, creds: Credentials): Promise<void> {
    const data = await this.#load();
    data.providers[providerId] = creds;
    await this.#flush(data);
  }

  async remove(providerId: string): Promise<void> {
    const data = await this.#load();
    delete data.providers[providerId];
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
