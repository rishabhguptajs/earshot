import { describe, expect, test } from 'bun:test';
import { buildRegistry, customProvider } from '../src/builtin.ts';
import { ModelCatalog } from '../src/catalog/index.ts';
import { SUPPORTED_PROVIDERS } from '../src/catalog/supported.ts';

const registry = buildRegistry();

describe('built-in providers', () => {
  test('every table entry produces a registered provider', () => {
    for (const entry of SUPPORTED_PROVIDERS) {
      expect(registry.get(entry.id)).toBeDefined();
    }
  });

  test('every OpenAI-compatible provider has a base URL', () => {
    // The generic adapter throws without one, and it would only surface on the
    // first real request - so catch it here instead.
    const missing = registry
      .list()
      .filter((p) => p.api === 'openai-completions' && !p.baseUrl)
      .map((p) => p.id);
    expect(missing).toEqual([]);
  });

  test('every key-based provider names at least one env var', () => {
    const missing = registry
      .list()
      .filter((p) => p.auth.kind === 'api-key')
      .filter((p) => !('envVars' in p.auth) || p.auth.envVars.length === 0)
      .map((p) => p.id);
    expect(missing).toEqual([]);
  });

  test('a wire adapter exists for every model on offer', () => {
    for (const provider of registry.list()) {
      for (const model of provider.models()) {
        expect(() => registry.wireFor(provider, model)).not.toThrow();
      }
    }
  });

  test('models carry a context window, output cap, and provider id', () => {
    for (const model of registry.models()) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
      expect(registry.get(model.providerId)).toBeDefined();
    }
  });

  test('reasoning models on replay-strict APIs are flagged', () => {
    const opus = registry.resolveModel('anthropic/claude-opus-5');
    expect(opus?.model.capabilities.reasoningReplay).toBe(true);
  });

  test('ships a broad catalog rather than a token few', () => {
    expect(registry.list().length).toBeGreaterThanOrEqual(18);
    expect(registry.models().length).toBeGreaterThan(500);
  });
});

describe('customProvider', () => {
  test('turns a base URL and model list into a working provider', () => {
    const provider = customProvider({
      id: 'my-vllm',
      baseUrl: 'http://gpu-box:8000/v1',
      models: [{ id: 'qwen3-coder' }],
    });
    expect(provider.api).toBe('openai-completions');
    expect(provider.models()[0]?.contextWindow).toBeGreaterThan(0);
    expect(provider.auth.kind).toBe('none');
  });

  test('registers alongside the built-ins without collision', () => {
    const r = buildRegistry({
      custom: [{ id: 'my-vllm', baseUrl: 'http://gpu-box:8000/v1', models: [{ id: 'q' }] }],
    });
    expect(r.resolveModel('my-vllm/q')).toBeDefined();
  });
});

describe('ModelCatalog', () => {
  test('overrides merge over catalog entries', () => {
    const catalog = new ModelCatalog();
    catalog.applyOverrides({ 'anthropic/claude-opus-5': { context: 42 } });
    const entry = SUPPORTED_PROVIDERS.find((p) => p.id === 'anthropic');
    if (!entry) throw new Error('anthropic missing from the provider table');
    const model = catalog.modelsFor(entry).find((m) => m.id === 'claude-opus-5');
    expect(model?.contextWindow).toBe(42);
  });

  test('unknown providers yield no models rather than throwing', () => {
    expect(
      new ModelCatalog().modelsFor({ id: 'nope', catalogId: 'nope', api: 'openai-completions' }),
    ).toEqual([]);
  });
});
