import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dataDir } from '../paths.ts';
import type { Model } from '../types.ts';
import type { FreeModel } from './free-table.ts';

/**
 * Which OpenRouter models are free, asked rather than remembered.
 *
 * This is the one place the catalog cannot be trusted at all. A snapshot five
 * days old already listed three `:free` models that no longer existed - one of
 * which was somebody's saved default and failed on their first turn - and named
 * none of the free models added since. Free listings churn on a timescale of
 * days; a vendored snapshot cannot track that, so it is not asked to.
 *
 * Two details the id does not tell you, which is why pricing is the filter:
 *
 *   - Not every free model carries the `:free` suffix. `openrouter/free` is
 *     free and does not.
 *   - A suffix is not a promise. An id can be repriced while keeping its name.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/models';
/** Long enough that startup is not a network call; short enough to track churn. */
const TTL_MS = 6 * 60 * 60 * 1000;

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number };
}

export interface FreeListing {
  fetchedAt: number;
  models: Array<Model & { tier: FreeModel['tier'] }>;
}

export const freeListingFile = (): string => join(dataDir(), 'openrouter-free.json');

/**
 * The free, tool-capable OpenRouter models, best first.
 *
 * A cached listing is served without a network call, and a failed fetch falls
 * back to whatever was cached however old it is: a stale list is a far better
 * answer than no pool, and the models in it are checked before use anyway.
 */
export async function openrouterFreeModels(
  opts: { now?: number; fetchImpl?: typeof fetch; path?: string } = {},
): Promise<Array<Model & { tier: FreeModel['tier'] }>> {
  const now = opts.now ?? Date.now();
  const path = opts.path ?? freeListingFile();
  const cached = await readCache(path);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.models;

  try {
    const models = await fetchFreeModels(opts.fetchImpl ?? fetch);
    await writeCache(path, { fetchedAt: now, models });
    return models;
  } catch {
    return cached?.models ?? [];
  }
}

async function fetchFreeModels(
  fetchImpl: typeof fetch,
): Promise<Array<Model & { tier: FreeModel['tier'] }>> {
  const response = await fetchImpl(ENDPOINT);
  if (!response.ok) throw new Error(`openrouter returned ${response.status}`);
  const body = (await response.json()) as { data?: OpenRouterModel[] };

  const free = (body.data ?? [])
    .filter(isFree)
    // A model that cannot call tools cannot run the agent loop, so it is not an
    // option for the pool however free it is.
    .filter((model) => model.supported_parameters?.includes('tools'))
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));

  return free.map((model, index) => ({
    id: model.id,
    providerId: 'openrouter',
    name: model.name ?? model.id,
    contextWindow: model.context_length ?? 32_768,
    maxOutputTokens: model.top_provider?.max_completion_tokens ?? 8_192,
    cost: { input: 0, output: 0 },
    capabilities: {
      tools: true,
      vision: model.supported_parameters?.includes('image') ?? false,
      reasoning: model.supported_parameters?.includes('reasoning') ?? false,
    },
    api: 'openai-completions' as const,
    // Ranked by context window, which is the one thing that is both comparable
    // across vendors and load-bearing for a coding agent. It is a proxy, and a
    // rough one, but it beats trusting a name.
    tier: index === 0 ? 'best' : index < 4 ? 'fast' : 'cheap',
  }));
}

/**
 * Free means priced at zero, not named `:free`.
 *
 * Three of OpenRouter's currently-free models do not carry the suffix, and a
 * suffixed id can be repriced without being renamed.
 */
function isFree(model: OpenRouterModel): boolean {
  const prompt = Number.parseFloat(model.pricing?.prompt ?? '0');
  const completion = Number.parseFloat(model.pricing?.completion ?? '0');
  return prompt === 0 && completion === 0;
}

async function readCache(path: string): Promise<FreeListing | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as FreeListing;
    return Array.isArray(parsed.models) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, listing: FreeListing): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(listing)}\n`, 'utf8');
    await rename(tmp, path);
  } catch {
    // A cache that cannot be written costs one fetch per session, which is not
    // worth failing a session over.
  }
}
