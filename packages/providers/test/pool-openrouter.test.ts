import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openrouterFreeModels } from '../src/pool/openrouter-free.ts';

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

async function tempPath() {
  return join(await mkdtemp(join(tmpdir(), 'earshot-orfree-')), 'free.json');
}

/** The shape OpenRouter's /api/v1/models actually returns. */
const body = {
  data: [
    {
      id: 'thinkingmachines/inkling:free',
      name: 'Inkling',
      context_length: 1_048_576,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools', 'reasoning'],
    },
    {
      // Free without the `:free` suffix. Filtering on the name would miss it.
      id: 'openrouter/free',
      name: 'Auto (free)',
      context_length: 200_000,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools', 'reasoning'],
    },
    {
      // Priced, so not an option however cheap it looks.
      id: 'anthropic/claude-opus-5',
      context_length: 500_000,
      pricing: { prompt: '0.000015', completion: '0.000075' },
      supported_parameters: ['tools'],
    },
    {
      // Free but cannot call tools, so it cannot run the agent loop.
      id: 'some/embedding-model:free',
      context_length: 8_192,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: [],
    },
  ],
};

function fakeFetch(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 503,
      json: async () => payload,
    }) as Response) as unknown as typeof fetch;
}

/**
 * The catalog cannot be trusted here at all. A five-day-old snapshot already
 * listed three `:free` models that no longer existed - one of them somebody's
 * saved default, which failed on their first turn - and none of the free models
 * added since.
 */
describe('resolving OpenRouter free models live', () => {
  test('filters on price, not on the `:free` suffix', async () => {
    const models = await openrouterFreeModels({
      now: NOW,
      path: await tempPath(),
      fetchImpl: fakeFetch(body),
    });

    expect(models.map((m) => m.id)).toEqual(['thinkingmachines/inkling:free', 'openrouter/free']);
  });

  test('drops models that cannot call tools', async () => {
    const models = await openrouterFreeModels({
      now: NOW,
      path: await tempPath(),
      fetchImpl: fakeFetch(body),
    });
    expect(models.some((m) => m.id.includes('embedding'))).toBe(false);
  });

  test('prices them at zero and carries real limits', async () => {
    const [best] = await openrouterFreeModels({
      now: NOW,
      path: await tempPath(),
      fetchImpl: fakeFetch(body),
    });

    expect(best?.cost).toEqual({ input: 0, output: 0 });
    expect(best?.contextWindow).toBe(1_048_576);
    expect(best?.providerId).toBe('openrouter');
    expect(best?.capabilities.tools).toBe(true);
    expect(best?.capabilities.reasoning).toBe(true);
    expect(best?.tier).toBe('best');
  });

  test('caches, so startup is not a network call', async () => {
    const path = await tempPath();
    let calls = 0;
    const counting = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;

    await openrouterFreeModels({ now: NOW, path, fetchImpl: counting });
    await openrouterFreeModels({ now: NOW + 60_000, path, fetchImpl: counting });
    expect(calls).toBe(1);

    const cached = JSON.parse(await readFile(path, 'utf8')) as { fetchedAt: number };
    expect(cached.fetchedAt).toBe(NOW);
  });

  test('refetches once the cache is stale', async () => {
    const path = await tempPath();
    let calls = 0;
    const counting = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;

    await openrouterFreeModels({ now: NOW, path, fetchImpl: counting });
    await openrouterFreeModels({ now: NOW + 7 * 60 * 60 * 1000, path, fetchImpl: counting });
    expect(calls).toBe(2);
  });

  /**
   * A stale list is a far better answer than no pool: the models in it are
   * checked before use anyway, and refusing to route because a vendor's status
   * page is down would be the wrong failure.
   */
  test('falls back to a stale cache when the fetch fails', async () => {
    const path = await tempPath();
    await writeFile(
      path,
      JSON.stringify({
        fetchedAt: 0,
        models: [{ id: 'cached/model', providerId: 'openrouter', tier: 'best' }],
      }),
    );

    const models = await openrouterFreeModels({
      now: NOW,
      path,
      fetchImpl: fakeFetch({}, false),
    });
    expect(models.map((m) => m.id)).toEqual(['cached/model']);
  });

  test('with no cache and no network, the pool simply has no OpenRouter models', async () => {
    const models = await openrouterFreeModels({
      now: NOW,
      path: await tempPath(),
      fetchImpl: (() => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    expect(models).toEqual([]);
  });
});
