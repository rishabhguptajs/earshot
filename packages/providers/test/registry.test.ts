import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '../src/registry.ts';
import type { Model, Provider } from '../src/types.ts';

const model = (id: string, providerId: string): Model => ({
  id,
  providerId,
  name: id,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  capabilities: { tools: true, vision: true, reasoning: true },
  api: 'anthropic-messages',
});

const provider = (id: string, ids: string[]): Provider => ({
  id,
  name: id,
  auth: { kind: 'api-key', envVars: [] },
  api: 'anthropic-messages',
  models: () => ids.map((m) => model(m, id)),
});

describe('ProviderRegistry', () => {
  test('rejects duplicate provider ids', () => {
    const r = new ProviderRegistry().register(provider('anthropic', []));
    expect(() => r.register(provider('anthropic', []))).toThrow();
  });

  test('resolves provider/model refs', () => {
    const r = new ProviderRegistry()
      .register(provider('anthropic', ['claude-opus-5']))
      .register(provider('openrouter', ['claude-opus-5']));
    expect(r.resolveModel('openrouter/claude-opus-5')?.provider.id).toBe('openrouter');
  });

  test('falls back to the first provider offering a bare model id', () => {
    const r = new ProviderRegistry()
      .register(provider('anthropic', ['claude-opus-5']))
      .register(provider('openrouter', ['claude-opus-5']));
    expect(r.resolveModel('claude-opus-5')?.provider.id).toBe('anthropic');
  });

  test('returns undefined for unknown models', () => {
    expect(new ProviderRegistry().resolveModel('nope/nope')).toBeUndefined();
  });

  test('throws when no wire adapter is registered', () => {
    const r = new ProviderRegistry().register(provider('anthropic', ['claude-opus-5']));
    const found = r.resolveModel('claude-opus-5');
    if (!found) throw new Error('expected the model to resolve');
    expect(() => r.wireFor(found.provider, found.model)).toThrow(/no wire adapter/);
  });
});
