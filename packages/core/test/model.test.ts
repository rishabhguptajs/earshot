import { describe, expect, test } from 'bun:test';
import { buildRegistry, type Model } from '@earshot/providers';
import {
  MissingCredentialsError,
  resolveModel,
  turnCost,
  UnknownModelError,
} from '../src/model.ts';

const registry = buildRegistry();

const model = (cost: Model['cost']): Model => ({
  id: 'm',
  providerId: 'p',
  name: 'm',
  contextWindow: 1000,
  maxOutputTokens: 100,
  capabilities: { tools: true, vision: false, reasoning: false },
  api: 'openai-completions',
  ...(cost ? { cost } : {}),
});

describe('turnCost', () => {
  test('prices input and output per million tokens', () => {
    const cost = turnCost(model({ input: 5, output: 25 }), {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(30, 6);
  });

  test('cached reads are billed at the cache rate, not twice', () => {
    // inputTokens is the total including cache reads; billing both would
    // overstate every cached turn, which is most turns in a long session.
    const cost = turnCost(model({ input: 5, output: 25, cacheRead: 0.5 }), {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 900_000,
    });
    expect(cost).toBeCloseTo(0.1 * 5 + 0.9 * 0.5, 6);
  });

  test('cache writes price separately from fresh input', () => {
    const cost = turnCost(model({ input: 5, output: 25, cacheWrite: 6.25 }), {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6.25, 6);
  });

  test('falls back to the input rate when a cache rate is unpublished', () => {
    const cost = turnCost(model({ input: 5, output: 25 }), {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5, 6);
  });

  test('a model with no published pricing costs nothing rather than NaN', () => {
    expect(turnCost(model(undefined), { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });
});

describe('resolveModel', () => {
  test('rejects an unknown reference', async () => {
    await expect(resolveModel(registry, 'nope/nope', { env: {} })).rejects.toBeInstanceOf(
      UnknownModelError,
    );
  });

  test('reports missing credentials with the env var to set', async () => {
    const error = await resolveModel(registry, 'anthropic/claude-opus-5', { env: {} }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(MissingCredentialsError);
    expect(error.message).toContain('ANTHROPIC_API_KEY');
  });

  test('picks up a key from the environment', async () => {
    const resolved = await resolveModel(registry, 'anthropic/claude-opus-5', {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
    });
    expect(resolved.credentials.apiKey).toBe('sk-test');
    expect(resolved.provider.id).toBe('anthropic');
  });

  test('an explicit key beats the environment', async () => {
    const resolved = await resolveModel(registry, 'anthropic/claude-opus-5', {
      apiKey: 'sk-cli',
      env: { ANTHROPIC_API_KEY: 'sk-env' },
    });
    expect(resolved.credentials.apiKey).toBe('sk-cli');
  });

  test('ambient providers resolve without a key', async () => {
    const resolved = await resolveModel(registry, 'bedrock/us.anthropic.claude-opus-5', {
      env: {},
    });
    expect(resolved.credentials.type).toBe('ambient');
  });
});
