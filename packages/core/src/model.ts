import {
  type Credentials,
  expandBaseUrl,
  isPoolTier,
  type Model,
  type ModelRequest,
  POOL_PROVIDER_ID,
  type PoolCandidate,
  type PoolOptions,
  type PoolTier,
  type Provider,
  type ProviderRegistry,
  poolCandidates,
  resolveCredentials,
  type StreamEvent,
  templatedBaseUrl,
  type WireContext,
} from '@earshot/providers';
import { type RouterOptions, routePooled } from './pool/router.ts';

export interface ResolvedModel {
  provider: Provider;
  model: Model;
  credentials: Credentials;
  /**
   * Present when the reference was a `free/*` tier. `provider`, `model` and
   * `credentials` still name whichever member is serving right now, so
   * everything that reads a resolved model - the status line, the transcript,
   * cost - reports what actually ran rather than the pool.
   */
  pool?: { tier: PoolTier; candidates: PoolCandidate[] };
}

export const DEFAULT_MODEL = 'anthropic/claude-opus-5';
/** What a connected pool runs on when nothing more specific is asked for. */
export const POOL_DEFAULT_MODEL = `${POOL_PROVIDER_ID}/best`;

export class MissingCredentialsError extends Error {
  /**
   * `reason` covers the case where a key is present but the credential is still
   * not usable - Cloudflare needs the account id its URL is built from. It is
   * the same failure from the user's side: something is missing before a call
   * can be made, and it should be said once, up front, not at request time.
   */
  constructor(
    readonly provider: Provider,
    reason?: string,
  ) {
    super(reason ?? describeMissingAuth(provider));
    this.name = 'MissingCredentialsError';
  }
}

/**
 * The pool exists but has nothing in it. Distinct from `MissingCredentialsError`,
 * which is about one provider: here the answer is to connect any free provider
 * at all, not to fix a particular key.
 */
export class EmptyPoolError extends Error {
  constructor(readonly poolName: string) {
    super(
      `no free providers are connected yet - run \`earshot pool setup\` to connect one, ` +
        'or choose a model with `earshot models`',
    );
    this.name = 'EmptyPoolError';
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
  opts: { apiKey?: string; env?: NodeJS.ProcessEnv; pool?: PoolOptions } = {},
): Promise<ResolvedModel> {
  const tier = poolTierOf(ref);
  if (tier) return resolvePool(registry, tier, opts);

  const found = registry.resolveModel(ref) ?? (await discoverModel(registry, ref));
  if (!found) throw new UnknownModelError(ref);

  const credentials = await resolveCredentials(found.provider, {
    ...(opts.apiKey ? { cliApiKey: opts.apiKey } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (!credentials) throw new MissingCredentialsError(found.provider);

  // An endpoint that names the account cannot be built from a key alone. Failing
  // here rather than at the wire is the difference between a message that says
  // what to set and a 404 against a URL with a literal `${...}` in it.
  if (templatedBaseUrl(found.provider.baseUrl)) {
    try {
      expandBaseUrl(found.provider.baseUrl ?? '', credentials, opts.env);
    } catch (error) {
      throw new MissingCredentialsError(found.provider, (error as Error).message);
    }
  }

  return { ...found, credentials };
}

/** `free/best` and friends, but not a real provider called `free` from a config. */
function poolTierOf(ref: string): PoolTier | undefined {
  const slash = ref.indexOf('/');
  if (slash < 0 || ref.slice(0, slash) !== POOL_PROVIDER_ID) return undefined;
  const tier = ref.slice(slash + 1);
  return isPoolTier(tier) ? tier : undefined;
}

/**
 * Binds a pool tier to whichever member serves it first.
 *
 * The whole candidate list is carried along, because the point of the pool is
 * that the choice is not final: the router walks it when a member turns out to
 * be exhausted, and quota is only checked when a request is about to be made.
 */
async function resolvePool(
  registry: ProviderRegistry,
  tier: PoolTier,
  opts: { env?: NodeJS.ProcessEnv; pool?: PoolOptions },
): Promise<ResolvedModel> {
  const candidates = await poolCandidates(registry, tier, {
    ...(opts.pool ?? {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  const first = candidates[0];
  if (!first) {
    const pool = registry.get(POOL_PROVIDER_ID);
    throw new EmptyPoolError(pool?.name ?? 'free pool');
  }
  return {
    provider: first.provider,
    model: first.model,
    credentials: first.credentials,
    pool: { tier, candidates },
  };
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

/**
 * Opens a stream for one model call. Transforms run here, in declared order.
 *
 * This is the only place a provider stream is opened - the agent loop,
 * subagents and the onboarding probe all come through here - which is why the
 * pool router wraps it rather than living in the loop.
 */
export function streamModel(
  registry: ProviderRegistry,
  resolved: ResolvedModel,
  request: Omit<ModelRequest, 'modelId'>,
  opts: RouterOptions = {},
): AsyncIterable<StreamEvent> {
  if (!resolved.pool) return streamOne(registry, resolved, request);

  return routePooled(
    {
      candidates: resolved.pool.candidates,
      open: (candidate, req) =>
        streamOne(
          registry,
          {
            provider: candidate.provider,
            model: candidate.model,
            credentials: candidate.credentials,
          },
          req,
        ),
    },
    request,
    opts,
  );
}

function streamOne(
  registry: ProviderRegistry,
  resolved: Omit<ResolvedModel, 'pool'>,
  request: Omit<ModelRequest, 'modelId'>,
): AsyncIterable<StreamEvent> {
  const { provider, model, credentials } = resolved;
  const wire = registry.wireFor(provider, model);

  let req: ModelRequest = { ...request, modelId: model.id };
  for (const transform of provider.transforms ?? []) req = transform.apply(req, model);

  const ctx: WireContext = {
    credentials,
    // Resolved per credential, not per provider: an endpoint that names the
    // account in its path is a different URL for each pooled account.
    ...(provider.baseUrl ? { baseUrl: expandBaseUrl(provider.baseUrl, credentials) } : {}),
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
