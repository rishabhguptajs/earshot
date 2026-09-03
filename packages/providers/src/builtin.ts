import { ModelCatalog, SUPPORTED_PROVIDERS, type SupportedProvider } from './catalog/index.ts';
import { ProviderRegistry } from './registry.ts';
import type { AuthSpec, Model, Provider, WireContext } from './types.ts';
import { ALL_WIRES } from './wire/adapters.ts';

/** Builds one `Provider` from a table entry plus the catalog. */
export function buildProvider(entry: SupportedProvider, catalog: ModelCatalog): Provider {
  const info = catalog.provider(entry.catalogId);
  const envVars = entry.envVars ?? info?.env ?? [];
  const baseUrl = entry.baseUrl ?? info?.api;
  const models = catalog.modelsFor(entry);

  return {
    id: entry.id,
    name: info?.name ?? entry.id,
    auth: toAuthSpec(entry, envVars, info?.doc),
    ...(baseUrl ? { baseUrl } : {}),
    api: entry.api,
    models: () => models,
    ...(entry.notice ? { notice: entry.notice } : {}),
  };
}

function toAuthSpec(entry: SupportedProvider, envVars: string[], doc?: string): AuthSpec {
  const helpUrl = doc ? { helpUrl: doc } : {};
  switch (entry.auth) {
    case 'none':
      return { kind: 'none' };
    case 'ambient':
      return {
        kind: 'ambient',
        description:
          entry.id === 'bedrock'
            ? 'the AWS credential chain (env, shared config, or instance role)'
            : 'Google Application Default Credentials',
      };
    case 'oauth':
      return { kind: 'oauth', flow: 'pkce', envVars, ...helpUrl };
    default:
      return { kind: 'api-key', envVars, ...helpUrl };
  }
}

/**
 * A user-configured OpenAI-compatible endpoint: any vendor or local runtime with
 * a base URL. This is the escape hatch that means an unknown provider never
 * requires a code change.
 */
export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseUrl: string;
  apiKeyEnv?: string;
  models: Array<{
    id: string;
    name?: string;
    context?: number;
    output?: number;
    reasoning?: boolean;
    vision?: boolean;
    tools?: boolean;
  }>;
}

export function customProvider(config: CustomProviderConfig): Provider {
  const models: Model[] = config.models.map((m) => ({
    id: m.id,
    providerId: config.id,
    name: m.name ?? m.id,
    contextWindow: m.context ?? 128_000,
    maxOutputTokens: m.output ?? 8_192,
    capabilities: {
      tools: m.tools ?? true,
      vision: m.vision ?? false,
      reasoning: m.reasoning ?? false,
    },
    api: 'openai-completions',
  }));

  return {
    id: config.id,
    name: config.name ?? config.id,
    auth: config.apiKeyEnv ? { kind: 'api-key', envVars: [config.apiKeyEnv] } : { kind: 'none' },
    baseUrl: config.baseUrl,
    api: 'openai-completions',
    models: () => models,
  };
}

/**
 * Ollama exposes an OpenAI-compatible `/v1`, but it drops tool calls when
 * streaming, so we point at that endpoint only for discovery and mark models as
 * needing the buffered path. Model discovery is live: whatever the user has pulled.
 */
export function ollamaProvider(
  baseUrl = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
): Provider {
  return {
    id: 'ollama',
    name: 'Ollama',
    auth: { kind: 'none' },
    baseUrl: `${baseUrl.replace(/\/$/, '')}/v1`,
    api: 'openai-completions',
    models: () => [],
    notice: 'Ollama drops tool calls from streamed responses; tool turns are buffered.',
    async fetchModels(ctx: WireContext): Promise<Model[]> {
      const root = (ctx.baseUrl ?? `${baseUrl}/v1`).replace(/\/v1\/?$/, '');
      const response = await fetch(`${root}/api/tags`);
      if (!response.ok) throw new Error(`ollama returned ${response.status}`);
      const body = (await response.json()) as {
        models?: Array<{ name: string; details?: { parameter_size?: string } }>;
      };
      return (body.models ?? []).map((m) => ({
        id: m.name,
        providerId: 'ollama',
        name: m.name,
        contextWindow: 32_768,
        maxOutputTokens: 8_192,
        capabilities: { tools: true, vision: false, reasoning: false },
        api: 'openai-completions' as const,
      }));
    },
  };
}

export interface BuildRegistryOptions {
  catalog?: ModelCatalog;
  custom?: CustomProviderConfig[];
}

/** The registry earshot boots with: every built-in provider and every wire adapter. */
export function buildRegistry(opts: BuildRegistryOptions = {}): ProviderRegistry {
  const catalog = opts.catalog ?? new ModelCatalog();
  const registry = new ProviderRegistry();

  for (const wire of ALL_WIRES) registry.registerWire(wire);
  for (const entry of SUPPORTED_PROVIDERS) registry.register(buildProvider(entry, catalog));
  registry.register(ollamaProvider());
  for (const config of opts.custom ?? []) registry.register(customProvider(config));

  return registry;
}
