import { describe, expect, test } from 'bun:test';
import { mkdtemp, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, resolveCredentials } from '../src/auth.ts';
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
