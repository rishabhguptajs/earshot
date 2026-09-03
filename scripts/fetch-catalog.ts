/**
 * Refreshes the vendored models.dev snapshot.
 *
 * models.dev is ~4.4 MB across 212 providers; we prune to the providers earshot
 * ships and the handful of fields the harness actually reads, which keeps the
 * bundled snapshot small enough to ship in the npm package. `earshot models
 * --refresh` hits the live endpoint for anything newer.
 */
import { writeFile } from 'node:fs/promises';
import { SUPPORTED_PROVIDER_IDS } from '../packages/providers/src/catalog/supported.ts';

const SOURCE = 'https://models.dev/api.json';
const OUT = 'packages/providers/src/catalog/snapshot.json';

interface RawModel {
  id: string;
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface RawProvider {
  id: string;
  name: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, RawModel>;
}

/**
 * The registry includes image, audio, and embedding models. A coding agent can
 * only drive text-out chat models, and the others arrive with no context limits,
 * so they are dropped rather than shipped as broken catalog entries.
 */
function isChatModel(m: RawModel): boolean {
  const output = m.modalities?.output ?? ['text'];
  return output.includes('text') && (m.limit?.context ?? 0) > 0;
}

const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`models.dev returned ${response.status}`);
  process.exit(1);
}
const raw = (await response.json()) as Record<string, RawProvider>;

const snapshot: Record<string, unknown> = {};
const missing: string[] = [];

for (const id of SUPPORTED_PROVIDER_IDS) {
  const provider = raw[id];
  if (!provider) {
    missing.push(id);
    continue;
  }
  snapshot[id] = {
    id,
    name: provider.name,
    env: provider.env ?? [],
    ...(provider.api ? { api: provider.api } : {}),
    ...(provider.doc ? { doc: provider.doc } : {}),
    models: Object.fromEntries(
      Object.entries(provider.models)
        .filter(([, m]) => isChatModel(m))
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

await writeFile(
  OUT,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), source: SOURCE, providers: snapshot }, null, 2)}\n`,
);

const models = Object.values(snapshot).reduce(
  (n, p) => n + Object.keys((p as { models: object }).models).length,
  0,
);
console.log(`wrote ${Object.keys(snapshot).length} providers / ${models} models -> ${OUT}`);
if (missing.length) console.warn(`not in models.dev: ${missing.join(', ')}`);
