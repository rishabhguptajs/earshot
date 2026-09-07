import {
  type Credentials,
  type Model,
  type ModelRequest,
  type Provider,
  type ProviderRegistry,
  resolveCredentials,
  type StreamEvent,
  type WireContext,
} from '@earshot/providers';

export interface ResolvedModel {
  provider: Provider;
  model: Model;
  credentials: Credentials;
}

export const DEFAULT_MODEL = 'anthropic/claude-opus-5';

export class MissingCredentialsError extends Error {
  constructor(readonly provider: Provider) {
    super(describeMissingAuth(provider));
    this.name = 'MissingCredentialsError';
  }
}

export class UnknownModelError extends Error {
  constructor(readonly ref: string) {
    super(`unknown model "${ref}"`);
    this.name = 'UnknownModelError';
  }
}

/**
 * Binds a model reference to a provider and its credentials. This is the single
 * place the CLI, the TUI and subagents go to turn "anthropic/claude-opus-5" into
 * something callable, so auth failures surface once, with a usable message.
 */
export async function resolveModel(
  registry: ProviderRegistry,
  ref: string,
  opts: { apiKey?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedModel> {
  const found = registry.resolveModel(ref) ?? (await discoverModel(registry, ref));
  if (!found) throw new UnknownModelError(ref);

  const credentials = await resolveCredentials(found.provider, {
    ...(opts.apiKey ? { cliApiKey: opts.apiKey } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (!credentials) throw new MissingCredentialsError(found.provider);

  return { ...found, credentials };
}

/**
 * Providers with live model discovery (Ollama, and any local runtime) publish no
 * static catalog, so a reference to one never matches until we ask the server what
 * it has. Only providers that opt in with `fetchModels` are probed, and a probe
 * that fails is treated as "no such model" rather than an error - the server
 * simply may not be running.
 */
async function discoverModel(
  registry: ProviderRegistry,
  ref: string,
): Promise<{ provider: Provider; model: Model } | undefined> {
  const slash = ref.indexOf('/');
  const candidates = registry
    .list()
    .filter((p) => p.fetchModels)
    .filter((p) => (slash > 0 ? p.id === ref.slice(0, slash) : true));

  const wanted = slash > 0 ? ref.slice(slash + 1) : ref;

  for (const provider of candidates) {
    try {
      const models = await provider.fetchModels?.({
        credentials: { type: 'ambient' },
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      });
      const model = models?.find((m) => m.id === wanted);
      if (model) return { provider, model };
    } catch {
      // The runtime is not reachable; fall through to "unknown model".
    }
  }
  return undefined;
}

function describeMissingAuth(provider: Provider): string {
  const { auth } = provider;
  const how =
    auth.kind === 'api-key' && auth.envVars.length
      ? `set ${auth.envVars.join(' or ')}, or run \`earshot auth login ${provider.id}\``
      : auth.kind === 'oauth'
        ? `run \`earshot auth login ${provider.id}\``
        : auth.kind === 'ambient'
          ? `configure ${auth.description}`
          : 'no credentials are configured';
  return `no credentials for ${provider.name}: ${how}`;
}

/** Opens a stream for one model call. Transforms run here, in declared order. */
export function streamModel(
  registry: ProviderRegistry,
  resolved: ResolvedModel,
  request: Omit<ModelRequest, 'modelId'>,
): AsyncIterable<StreamEvent> {
  const { provider, model, credentials } = resolved;
  const wire = registry.wireFor(provider, model);

  let req: ModelRequest = { ...request, modelId: model.id };
  for (const transform of provider.transforms ?? []) req = transform.apply(req, model);

  const ctx: WireContext = {
    credentials,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  };
  return wire.stream(req, ctx);
}

/** USD for one turn, from catalog pricing. Cache reads and writes price separately. */
export function turnCost(
  model: Model,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): number {
  const cost = model.cost;
  if (!cost) return 0;
  const per = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  // Cached reads are billed at the cache rate instead of the input rate, so they
  // must not also be counted as fresh input.
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const freshInput = Math.max(0, usage.inputTokens - cacheRead);
  return (
    per(freshInput, cost.input) +
    per(usage.outputTokens, cost.output) +
    per(cacheRead, cost.cacheRead ?? cost.input) +
    per(cacheWrite, cost.cacheWrite ?? cost.input)
  );
}
