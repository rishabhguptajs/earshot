import { afterAll, describe, expect, test } from 'bun:test';
import { ollamaProvider, ProviderRegistry } from '@earshot/providers';
import { resolveModel, UnknownModelError } from '../src/model.ts';

/**
 * Providers with live discovery publish no static catalog, so resolution has to
 * ask the running server. Served here by a stub so the test does not need a real
 * Ollama install.
 */
const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === '/api/tags') {
      return Response.json({ models: [{ name: 'qwen3-coder' }, { name: 'llama3.2' }] });
    }
    return new Response('not found', { status: 404 });
  },
});

const host = `http://127.0.0.1:${server.port}`;
const registry = new ProviderRegistry().register(ollamaProvider(host));

afterAll(() => server.stop(true));

describe('live model discovery', () => {
  test('resolves a model the server reports but the catalog never listed', async () => {
    const resolved = await resolveModel(registry, 'ollama/qwen3-coder', { env: {} });
    expect(resolved.model.id).toBe('qwen3-coder');
    expect(resolved.provider.id).toBe('ollama');
  });

  test('resolves a bare model id through discovery', async () => {
    const resolved = await resolveModel(registry, 'llama3.2', { env: {} });
    expect(resolved.provider.id).toBe('ollama');
  });

  test('a model the server does not have is still unknown', async () => {
    await expect(resolveModel(registry, 'ollama/not-pulled', { env: {} })).rejects.toBeInstanceOf(
      UnknownModelError,
    );
  });

  test('an unreachable runtime reports unknown model, not a crash', async () => {
    // Port 1 is closed; the user most likely just has not started the server.
    const offline = new ProviderRegistry().register(ollamaProvider('http://127.0.0.1:1'));
    await expect(resolveModel(offline, 'ollama/anything', { env: {} })).rejects.toBeInstanceOf(
      UnknownModelError,
    );
  });

  test('local runtimes need no credentials', async () => {
    const resolved = await resolveModel(registry, 'ollama/qwen3-coder', { env: {} });
    expect(resolved.credentials.type).toBe('ambient');
  });
});
