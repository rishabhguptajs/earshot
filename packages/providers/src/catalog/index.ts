import type { Model, ModelCapabilities, ModelCost, WireApiKind } from '../types.ts';
import snapshot from './snapshot.json' with { type: 'json' };
import { SUPPORTED_PROVIDERS, type SupportedProvider } from './supported.ts';

export type { SupportedProvider } from './supported.ts';
export { SUPPORTED_PROVIDER_IDS, SUPPORTED_PROVIDERS } from './supported.ts';

export interface CatalogModel {
  id: string;
  name: string;
  context: number;
  output: number;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  cost?: ModelCost;
  releaseDate?: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  env: string[];
  api?: string;
  doc?: string;
  models: Record<string, CatalogModel>;
}

export interface Catalog {
  generatedAt: string;
  source: string;
  providers: Record<string, CatalogProvider>;
}

const bundled = snapshot as unknown as Catalog;

/**
 * The model catalog. Defaults to the snapshot vendored at build time; a refresh
 * (`earshot models --refresh`) swaps in a live copy, and user config can override
 * or add entries for models the registry does not know about yet.
 */
export class ModelCatalog {
  #catalog: Catalog;
  #overrides: Record<string, Partial<CatalogModel>> = {};

  constructor(catalog: Catalog = bundled) {
    this.#catalog = catalog;
  }

  get generatedAt(): string {
    return this.#catalog.generatedAt;
  }

  provider(catalogId: string): CatalogProvider | undefined {
    return this.#catalog.providers[catalogId];
  }

  /** Keyed `"<providerId>/<modelId>"`; merged over the catalog entry. */
  applyOverrides(overrides: Record<string, Partial<CatalogModel>>): void {
    this.#overrides = { ...this.#overrides, ...overrides };
  }

  /** Builds the unified `Model` list for one supported provider. */
  modelsFor(supported: SupportedProvider): Model[] {
    const provider = this.provider(supported.catalogId);
    if (!provider) return [];
    return Object.values(provider.models).map((m) =>
      this.#toModel({ ...m, ...this.#overrides[`${supported.id}/${m.id}`] }, supported),
    );
  }

  #toModel(m: CatalogModel, supported: SupportedProvider): Model {
    const capabilities: ModelCapabilities = {
      tools: m.tools,
      vision: m.vision,
      reasoning: m.reasoning,
      // Providers that will 400 unless prior reasoning blocks are replayed verbatim.
      ...(m.reasoning && REASONING_REPLAY.has(supported.api) ? { reasoningReplay: true } : {}),
    };
    return {
      id: m.id,
      providerId: supported.id,
      name: m.name,
      contextWindow: m.context,
      maxOutputTokens: m.output,
      capabilities,
      api: supported.api,
      ...(m.cost ? { cost: m.cost } : {}),
      ...(m.releaseDate ? { releaseDate: m.releaseDate } : {}),
    };
  }
}

const REASONING_REPLAY: Set<WireApiKind> = new Set([
  'anthropic-messages',
  'openai-responses',
  'openai-codex-responses',
  'google-generative-ai',
  'google-vertex',
]);

/** Fetches a fresh catalog from models.dev, pruned the same way as the snapshot. */
export async function fetchCatalog(source = bundled.source): Promise<Catalog> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
  const raw = (await response.json()) as Record<string, RawProvider>;

  const providers: Record<string, CatalogProvider> = {};
  for (const id of new Set(SUPPORTED_PROVIDERS.map((p) => p.catalogId))) {
    const p = raw[id];
    if (!p) continue;
    providers[id] = {
      id,
      name: p.name,
      env: p.env ?? [],
      ...(p.api ? { api: p.api } : {}),
      ...(p.doc ? { doc: p.doc } : {}),
      models: Object.fromEntries(
        Object.entries(p.models)
          .filter(([, m]) => (m.modalities?.output ?? ['text']).includes('text'))
          .filter(([, m]) => (m.limit?.context ?? 0) > 0)
          .map(([modelId, m]) => [
            modelId,
            {
              id: m.id,
              name: m.name,
              context: m.limit?.context || 128_000,
              output: m.limit?.output || 8_192,
              reasoning: m.reasoning ?? false,
              tools: m.tool_call ?? true,
              vision: m.modalities?.input?.includes('image') ?? false,
              ...(m.release_date ? { releaseDate: m.release_date } : {}),
              ...(m.cost
                ? {
                    cost: {
                      input: m.cost.input ?? 0,
                      output: m.cost.output ?? 0,
                      ...(m.cost.cache_read != null ? { cacheRead: m.cost.cache_read } : {}),
                      ...(m.cost.cache_write != null ? { cacheWrite: m.cost.cache_write } : {}),
                    },
                  }
                : {}),
            },
          ]),
      ),
    };
  }
  return { generatedAt: new Date().toISOString(), source, providers };
}

interface RawProvider {
  name: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<
    string,
    {
      id: string;
      name: string;
      reasoning?: boolean;
      tool_call?: boolean;
      release_date?: string;
      modalities?: { input?: string[]; output?: string[] };
      limit?: { context?: number; output?: number };
      cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
    }
  >;
}
