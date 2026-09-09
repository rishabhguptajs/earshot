import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth.ts';
import { buildRegistry } from '../src/builtin.ts';
import type { FreeTier } from '../src/pool/free-table.ts';
import { POOL_PROVIDER_ID, poolCandidates, poolProvider } from '../src/pool/provider.ts';

const registry = buildRegistry();

async function tempStore() {
  return new AuthStore(join(await mkdtemp(join(tmpdir(), 'earshot-pool-')), 'auth.json'));
}

/** A table under the test's control, so real vendor churn cannot break it. */
const tiers: FreeTier[] = [
  {
    providerId: 'groq',
    label: 'Groq',
    signupUrl: 'https://console.groq.com/keys',
    limits: { rpm: 30, rpd: 14_400 },
    trainsOnData: false,
    models: [
      { id: 'openai/gpt-oss-120b', tier: 'best' },
      { id: 'llama-3.1-8b-instant', tier: 'cheap' },
    ],
  },
  {
    providerId: 'google',
    label: 'Google AI Studio',
    signupUrl: 'https://aistudio.google.com/apikey',
    limits: { rpm: 10, rpd: 250 },
    trainsOnData: true,
    models: [{ id: 'gemini-2.5-flash', tier: 'best' }],
  },
  {
    providerId: 'ollama',
    label: 'Ollama',
    signupUrl: 'https://ollama.com/download',
    limits: {},
    trainsOnData: false,
    models: [],
  },
];

describe('the free pseudo-provider', () => {
  test('publishes intent-named models, not vendor-named ones', () => {
    const pool = registry.get(POOL_PROVIDER_ID);
    expect(pool).toBeDefined();
    expect(pool?.models().map((m) => m.id)).toEqual(['best', 'fast', 'cheap']);
  });

  /**
   * Everything downstream reads a `Model`: the context budget, the reasoning
   * gate, the system prompt. A tier that carried placeholder numbers would
   * misreport all three, so each is a copy of a real candidate.
   */
  test('each tier carries the real limits of the model behind it', () => {
    for (const model of registry.get(POOL_PROVIDER_ID)?.models() ?? []) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
      expect(model.capabilities.tools).toBe(true);
    }
  });

  test('the pool is free, whatever the model behind it costs', () => {
    for (const model of registry.get(POOL_PROVIDER_ID)?.models() ?? []) {
      expect(model.cost).toEqual({ input: 0, output: 0 });
    }
  });

  test('a tier with nothing behind it is not published at all', () => {
    const empty = poolProvider(registry, { tiers: [] });
    expect(empty.models()).toEqual([]);
  });
});

describe('pool candidates', () => {
  test('are empty until something is connected', async () => {
    const store = await tempStore();
    expect(await poolCandidates(registry, 'best', { store, tiers, env: {} })).toEqual([]);
  });

  test('one per account, in table order', async () => {
    const store = await tempStore();
    await store.set('google', { type: 'api-key', apiKey: 'g' });
    await store.set('groq', { type: 'api-key', apiKey: 'a' });
    await store.setAccount('groq', 'work', { type: 'api-key', apiKey: 'b' });

    const candidates = await poolCandidates(registry, 'best', { store, tiers, env: {} });
    expect(candidates.map((c) => c.bucket)).toEqual([
      'groq#default',
      'groq#work',
      'google#default',
    ]);
    expect(candidates.map((c) => c.credentials.apiKey)).toEqual(['a', 'b', 'g']);
  });

  test('a key already in the environment is pooled without re-entering it', async () => {
    const store = await tempStore();
    const candidates = await poolCandidates(registry, 'best', {
      store,
      tiers,
      env: { GROQ_API_KEY: 'from-env' },
    });
    expect(candidates.map((c) => c.bucket)).toEqual(['groq#default']);
    expect(candidates[0]?.credentials.apiKey).toBe('from-env');
  });

  test('settings can reorder the table', async () => {
    const store = await tempStore();
    await store.set('google', { type: 'api-key', apiKey: 'g' });
    await store.set('groq', { type: 'api-key', apiKey: 'a' });

    const candidates = await poolCandidates(registry, 'best', {
      store,
      tiers,
      env: {},
      ranking: { 'google/gemini-2.5-flash': -1 },
    });
    expect(candidates[0]?.provider.id).toBe('google');
  });

  /**
   * earshot reads private source code. Whether a free tier may train on what it
   * is sent is shown rather than buried, and a user who cares can exclude those
   * tiers outright - at the cost of most of the free capacity, which is theirs
   * to weigh.
   */
  test('training providers can be excluded outright', async () => {
    const store = await tempStore();
    await store.set('google', { type: 'api-key', apiKey: 'g' });
    await store.set('groq', { type: 'api-key', apiKey: 'a' });

    const all = await poolCandidates(registry, 'best', { store, tiers, env: {} });
    expect(all.some((c) => c.trainsOnData)).toBe(true);

    const strict = await poolCandidates(registry, 'best', {
      store,
      tiers,
      env: {},
      excludeTrainingProviders: true,
    });
    expect(strict.map((c) => c.provider.id)).toEqual(['groq']);
  });

  test('tiers do not leak into one another', async () => {
    const store = await tempStore();
    await store.set('groq', { type: 'api-key', apiKey: 'a' });

    const cheap = await poolCandidates(registry, 'cheap', { store, tiers, env: {} });
    expect(cheap.map((c) => c.model.id)).toEqual(['llama-3.1-8b-instant']);
    expect(await poolCandidates(registry, 'fast', { store, tiers, env: {} })).toEqual([]);
  });

  test('an id the vendor has retired is skipped, not fatal', async () => {
    const store = await tempStore();
    await store.set('groq', { type: 'api-key', apiKey: 'a' });
    const withGhost: FreeTier[] = [
      {
        ...(tiers[0] as FreeTier),
        models: [
          { id: 'model-that-no-longer-exists', tier: 'best' },
          { id: 'openai/gpt-oss-120b', tier: 'best' },
        ],
      },
    ];

    const candidates = await poolCandidates(registry, 'best', { store, tiers: withGhost, env: {} });
    expect(candidates.map((c) => c.model.id)).toEqual(['openai/gpt-oss-120b']);
  });

  /**
   * Cloudflare's endpoint is built from the account id, so a stored key without
   * one addresses nothing. It is skipped for the same reason a retired model is:
   * the candidate list is what still works, and routing to it would fail the
   * turn rather than degrade it.
   */
  test('an account whose endpoint cannot be built is skipped', async () => {
    const store = await tempStore();
    await store.setAccount('cloudflare', 'default', { type: 'api-key', apiKey: 'no-account-id' });
    await store.setAccount('cloudflare', 'account-2', {
      type: 'api-key',
      apiKey: 'k',
      extra: { CLOUDFLARE_ACCOUNT_ID: 'acct2' },
    });

    const cloudflare: FreeTier[] = [
      {
        providerId: 'cloudflare',
        label: 'Cloudflare Workers AI',
        signupUrl: 'https://dash.cloudflare.com',
        limits: { rpd: 150 },
        trainsOnData: false,
        models: [{ id: '@cf/openai/gpt-oss-20b', tier: 'fast' }],
      },
    ];

    const candidates = await poolCandidates(registry, 'fast', {
      store,
      tiers: cloudflare,
      env: {},
    });
    expect(candidates.map((c) => c.account)).toEqual(['account-2']);
  });
});

/**
 * Local runtimes are the only pool members that cannot run out, so they are the
 * floor everything else falls back to. They publish no static catalog - what
 * they serve is whatever the user has pulled - so they have to be asked.
 */
describe('local runtimes in the pool', () => {
  const local: FreeTier[] = [
    tiers[0] as FreeTier,
    {
      providerId: 'ollama',
      label: 'Ollama',
      signupUrl: 'https://ollama.com/download',
      limits: {},
      trainsOnData: false,
      models: [],
    },
  ];

  function withOllama(models: string[]) {
    const fake = buildRegistry();
    const ollama = fake.get('ollama');
    if (!ollama) throw new Error('ollama is not registered');
    ollama.fetchModels = async () =>
      models.map((id) => ({
        id,
        providerId: 'ollama',
        name: id,
        contextWindow: 32_768,
        maxOutputTokens: 8_192,
        capabilities: { tools: true, vision: false, reasoning: false },
        api: 'ollama-native' as const,
      }));
    return fake;
  }

  test('are discovered live and sort after every metered account', async () => {
    const store = await tempStore();
    await store.set('groq', { type: 'api-key', apiKey: 'a' });

    const candidates = await poolCandidates(withOllama(['qwen3:8b']), 'best', {
      store,
      tiers: local,
      env: {},
    });
    expect(candidates.map((c) => c.bucket)).toEqual(['groq#default', 'ollama#default']);
    expect(candidates.at(-1)?.local).toBe(true);
    expect(candidates.at(-1)?.limits).toEqual({});
  });

  test('a runtime that is not running is simply not an option', async () => {
    const fake = buildRegistry();
    const ollama = fake.get('ollama');
    if (!ollama) throw new Error('ollama is not registered');
    ollama.fetchModels = async () => {
      throw new Error('connection refused');
    };

    const store = await tempStore();
    expect(await poolCandidates(fake, 'best', { store, tiers: local, env: {} })).toEqual([]);
  });

  test('serve every tier, because there is no list to rank them by', async () => {
    const store = await tempStore();
    const fake = withOllama(['qwen3:8b']);
    for (const tier of ['best', 'fast', 'cheap'] as const) {
      const candidates = await poolCandidates(fake, tier, { store, tiers: local, env: {} });
      expect(candidates.map((c) => c.model.id)).toEqual(['qwen3:8b']);
    }
  });
});
