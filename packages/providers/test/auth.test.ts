import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, DEFAULT_ACCOUNT, resolveCredentials } from '../src/auth.ts';
import type { Provider } from '../src/types.ts';

const anthropic: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  auth: { kind: 'api-key', envVars: ['ANTHROPIC_API_KEY'] },
  api: 'anthropic-messages',
  models: () => [],
};

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'earshot-auth-'));
  return new AuthStore(join(dir, 'auth.json'));
}

describe('AuthStore', () => {
  test('round-trips credentials and persists them across instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'earshot-auth-'));
    const path = join(dir, 'auth.json');
    const store = new AuthStore(path);
    await store.set('anthropic', { type: 'api-key', apiKey: 'sk-test' });
    expect((await store.get('anthropic'))?.apiKey).toBe('sk-test');
    expect((await new AuthStore(path).get('anthropic'))?.apiKey).toBe('sk-test');
  });

  // Windows has no POSIX mode bits - file security there comes from the ACLs on
  // the user profile directory instead, so there is nothing to assert.
  test.skipIf(platform() === 'win32')('the auth file is not readable by other users', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'earshot-auth-'));
    const path = join(dir, 'auth.json');
    await new AuthStore(path).set('anthropic', { type: 'api-key', apiKey: 'sk-test' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('remove deletes the entry', async () => {
    const store = await tempStore();
    await store.set('anthropic', { type: 'api-key', apiKey: 'sk-test' });
    await store.remove('anthropic');
    expect(await store.get('anthropic')).toBeUndefined();
  });

  test('missing file reads as empty rather than throwing', async () => {
    expect(await new AuthStore('/nonexistent/earshot/auth.json').get('anthropic')).toBeUndefined();
  });
});

describe('resolveCredentials', () => {
  test('prefers the CLI key over env and store', async () => {
    const store = await tempStore();
    await store.set('anthropic', { type: 'api-key', apiKey: 'from-store' });
    const creds = await resolveCredentials(anthropic, {
      cliApiKey: 'from-cli',
      env: { ANTHROPIC_API_KEY: 'from-env' },
      store,
    });
    expect(creds?.apiKey).toBe('from-cli');
  });

  test('prefers env over the store', async () => {
    const store = await tempStore();
    await store.set('anthropic', { type: 'api-key', apiKey: 'from-store' });
    const creds = await resolveCredentials(anthropic, {
      env: { ANTHROPIC_API_KEY: 'from-env' },
      store,
    });
    expect(creds?.apiKey).toBe('from-env');
  });

  test('falls back to the store when no env var is set', async () => {
    const store = await tempStore();
    await store.set('anthropic', { type: 'api-key', apiKey: 'from-store' });
    expect((await resolveCredentials(anthropic, { env: {}, store }))?.apiKey).toBe('from-store');
  });

  test('returns undefined when a key-based provider has no credentials', async () => {
    expect(
      await resolveCredentials(anthropic, { env: {}, store: await tempStore() }),
    ).toBeUndefined();
  });

  test('ambient providers resolve without stored credentials', async () => {
    const bedrock: Provider = {
      ...anthropic,
      id: 'bedrock',
      auth: { kind: 'ambient', description: 'AWS credential chain' },
    };
    expect((await resolveCredentials(bedrock, { env: {}, store: await tempStore() }))?.type).toBe(
      'ambient',
    );
  });
});

/**
 * Free tiers meter per account, not per key, so pooling capacity means holding
 * several named credentials for one provider. The v1 shape - one `Credentials`
 * per provider - is on users' disks right now and has to keep working, and a
 * user who never adds a second account should never have their file rewritten
 * into a shape an older earshot cannot read.
 */
describe('AuthStore: named accounts', () => {
  async function tempPath() {
    return join(await mkdtemp(join(tmpdir(), 'earshot-auth-')), 'auth.json');
  }

  test('reads a v1 file as a single default account', async () => {
    const path = await tempPath();
    await writeFile(
      path,
      JSON.stringify({ version: 1, providers: { groq: { type: 'api-key', apiKey: 'gsk_one' } } }),
    );
    const store = new AuthStore(path);

    expect((await store.get('groq'))?.apiKey).toBe('gsk_one');
    const accounts = await store.listAccounts('groq');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.account).toBe(DEFAULT_ACCOUNT);
    expect(accounts[0]?.apiKey).toBe('gsk_one');
  });

  test('a lone default account is still written in the v1 shape', async () => {
    const path = await tempPath();
    await new AuthStore(path).set('groq', { type: 'api-key', apiKey: 'gsk_one' });

    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      providers: Record<string, unknown>;
    };
    expect(raw.version).toBe(1);
    expect(raw.providers.groq).toEqual({ type: 'api-key', apiKey: 'gsk_one' });
  });

  test('a second account upgrades the file and both survive a reload', async () => {
    const path = await tempPath();
    const store = new AuthStore(path);
    await store.set('groq', { type: 'api-key', apiKey: 'gsk_one' });
    await store.setAccount('groq', 'work', { type: 'api-key', apiKey: 'gsk_two' });

    const raw = JSON.parse(await readFile(path, 'utf8')) as { version: number };
    expect(raw.version).toBe(2);

    const reopened = new AuthStore(path);
    expect((await reopened.listAccounts('groq')).map((one) => one.account)).toEqual([
      DEFAULT_ACCOUNT,
      'work',
    ]);
    // A bare provider id keeps meaning the default account, so nothing that
    // predates the pool changes behaviour.
    expect((await reopened.get('groq'))?.apiKey).toBe('gsk_one');
  });

  test('setAccount replaces rather than duplicating a name', async () => {
    const path = await tempPath();
    const store = new AuthStore(path);
    await store.setAccount('groq', 'work', { type: 'api-key', apiKey: 'first' });
    await store.setAccount('groq', 'work', { type: 'api-key', apiKey: 'second' });

    const accounts = await store.listAccounts('groq');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.apiKey).toBe('second');
  });

  test('removing back down to a lone default restores the v1 shape', async () => {
    const path = await tempPath();
    const store = new AuthStore(path);
    await store.set('groq', { type: 'api-key', apiKey: 'gsk_one' });
    await store.setAccount('groq', 'work', { type: 'api-key', apiKey: 'gsk_two' });
    await store.removeAccount('groq', 'work');

    const raw = JSON.parse(await readFile(path, 'utf8')) as { providers: Record<string, unknown> };
    expect(raw.providers.groq).toEqual({ type: 'api-key', apiKey: 'gsk_one' });
    expect((await store.get('groq'))?.apiKey).toBe('gsk_one');
  });

  test('removing the last account drops the provider entirely', async () => {
    const path = await tempPath();
    const store = new AuthStore(path);
    await store.setAccount('groq', 'work', { type: 'api-key', apiKey: 'gsk_two' });
    await store.removeAccount('groq', 'work');

    expect(await store.get('groq')).toBeUndefined();
    expect(await store.listAccounts('groq')).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  test('logout still forgets every account for the provider', async () => {
    const path = await tempPath();
    const store = new AuthStore(path);
    await store.set('groq', { type: 'api-key', apiKey: 'one' });
    await store.setAccount('groq', 'work', { type: 'api-key', apiKey: 'two' });
    await store.remove('groq');

    expect(await store.listAccounts('groq')).toEqual([]);
  });
});
