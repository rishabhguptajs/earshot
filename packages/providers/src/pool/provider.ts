import { AuthStore, DEFAULT_ACCOUNT, resolveCredentials } from '../auth.ts';
import { expandBaseUrl, templatedBaseUrl } from '../base-url.ts';
import type { ProviderRegistry } from '../registry.ts';
import type { Credentials, Model, Provider } from '../types.ts';
import { FREE_TIERS, type FreeTier, LOCAL_TIERS } from './free-table.ts';
import { bucketKey, type QuotaLimits } from './ledger.ts';
import { openrouterFreeModels } from './openrouter-free.ts';

/**
 * The `free` pseudo-provider.
 *
 * It publishes three models - `free/best`, `free/fast`, `free/cheap` - that
 * name an intent rather than a vendor. Everything downstream keeps seeing a
 * concrete provider and model once one is chosen, so the status line, the cost
 * accounting and the transcript all say what actually served the request.
 *
 * The synthetic models are copies of the best concrete candidate for each tier,
 * so `contextWindow`, `maxOutputTokens` and `capabilities` are real numbers and
 * nothing that reads a `Model` has to learn about pooling.
 */

export const POOL_PROVIDER_ID = 'free';
export const POOL_TIERS = ['best', 'fast', 'cheap'] as const;
export type PoolTier = (typeof POOL_TIERS)[number];

export const isPoolTier = (value: string): value is PoolTier =>
  (POOL_TIERS as readonly string[]).includes(value);

/** One routable option: a concrete model, on one account, with its quota bucket. */
export interface PoolCandidate {
  provider: Provider;
  model: Model;
  credentials: Credentials;
  account: string;
  /** `providerId#account` - the unit vendors meter and the ledger counts. */
  bucket: string;
  limits: QuotaLimits;
  trainsOnData: boolean;
  /** No quota and no key; reached only when every metered tier is spent. */
  local: boolean;
}

export interface PoolOptions {
  store?: AuthStore;
  /** Live free listings, keyed by provider id. Resolved once per lookup. */
  live?: Record<string, Array<Model & { tier: PoolTier }>>;
  env?: NodeJS.ProcessEnv;
  /** Per-`provider/model` rank override from settings; lower sorts first. */
  ranking?: Record<string, number>;
  /** Leaves out tiers documented as training on submitted data. */
  excludeTrainingProviders?: boolean;
  tiers?: FreeTier[];
}

/**
 * Every free model the table names that the catalog still has, best first.
 *
 * Ids that have gone are skipped rather than fatal: free model lists rot on a
 * timescale of days, and a pool that refuses to start because one vendor
 * retired one model would be useless.
 */
function ranked(registry: ProviderRegistry, tier: PoolTier, opts: PoolOptions) {
  const out: Array<{ provider: Provider; model: Model; free: FreeTier; rank: number }> = [];
  const tiers = opts.tiers ?? FREE_TIERS;

  for (const [providerRank, free] of tiers.entries()) {
    if (opts.excludeTrainingProviders && free.trainsOnData) continue;
    // Local runtimes publish no static catalog - what they serve is whatever
    // the user has pulled - so they are discovered live, not ranked from a list.
    if (LOCAL_TIERS.has(free.providerId)) continue;
    const provider = registry.get(free.providerId);
    if (!provider) continue;
    const available = provider.models();

    // A provider whose free list is resolved live brings its own models: the
    // catalog does not know which of them are free today, and being wrong about
    // that means routing to one that will be billed or has been retired.
    if (free.live) {
      for (const [modelRank, model] of (opts.live?.[free.providerId] ?? []).entries()) {
        if (model.tier !== tier) continue;
        out.push({
          provider,
          model,
          free,
          rank: opts.ranking?.[`${provider.id}/${model.id}`] ?? providerRank * 100 + modelRank,
        });
      }
      continue;
    }

    for (const [modelRank, wanted] of free.models.entries()) {
      if (wanted.tier !== tier) continue;
      const model = available.find((one) => one.id === wanted.id);
      // A model that cannot call tools cannot run the loop, so it is not an
      // option however cheap it is.
      if (!model?.capabilities.tools) continue;
      const ref = `${provider.id}/${model.id}`;
      out.push({
        provider,
        model,
        free,
        rank: opts.ranking?.[ref] ?? providerRank * 100 + modelRank,
      });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** The synthetic `Model` for one tier, copied from its best concrete candidate. */
function tierModel(
  registry: ProviderRegistry,
  tier: PoolTier,
  opts: PoolOptions,
): Model | undefined {
  const best = ranked(registry, tier, opts)[0];
  if (!best) return undefined;
  return {
    ...best.model,
    id: tier,
    providerId: POOL_PROVIDER_ID,
    name: `Free pool (${tier})`,
    // Free is free. Leaving the concrete model's pricing here would bill a
    // session for tokens nobody was charged for.
    cost: { input: 0, output: 0 },
  };
}

export function poolProvider(registry: ProviderRegistry, opts: PoolOptions = {}): Provider {
  const models = POOL_TIERS.map((tier) => tierModel(registry, tier, opts)).filter(
    (model): model is Model => model !== undefined,
  );
  return {
    id: POOL_PROVIDER_ID,
    name: 'Free pool',
    // Credentials belong to whichever member serves the request; the pool
    // itself has none, and asking for one would be asking the wrong question.
    auth: { kind: 'none' },
    api: (model: Model) => model.api,
    models: () => models,
    notice: 'routes across every free provider you have connected',
  };
}

/**
 * The routable candidates for a tier, best first, each bound to one account.
 *
 * Credentials are resolved here rather than in `poolProvider` because
 * `Provider.models()` is synchronous and reading the auth store is not - and
 * because which accounts exist can change inside a session, when the setup
 * wizard is run from `/pool`.
 */
export async function poolCandidates(
  registry: ProviderRegistry,
  tier: PoolTier,
  opts: PoolOptions = {},
): Promise<PoolCandidate[]> {
  const store = opts.store ?? new AuthStore();
  const live = opts.live ?? (await liveListings(opts));
  const candidates: PoolCandidate[] = [];

  for (const entry of ranked(registry, tier, { ...opts, live })) {
    const accounts = await store.listAccounts(entry.provider.id);

    // A local runtime needs no key, and an env var counts as one account even
    // when nothing has been stored - that is how someone who already had a key
    // before the pool existed gets pooled without re-entering it.
    if (accounts.length === 0) {
      const ambient = await resolveCredentials(entry.provider, {
        ...(opts.env ? { env: opts.env } : {}),
        store,
      }).catch(() => undefined);
      if (!ambient) continue;
      accounts.push({ ...ambient, account: DEFAULT_ACCOUNT });
    }

    for (const account of accounts) {
      const { account: name, ...credentials } = account;
      // An account whose endpoint cannot be built is not a routable option -
      // Cloudflare needs the account id its URL is made of. Skipped rather than
      // fatal, exactly like a model the vendor has retired: the pool is a list
      // of what still works.
      if (!callable(entry.provider, credentials, opts.env)) continue;
      candidates.push({
        provider: entry.provider,
        model: entry.model,
        credentials,
        account: name,
        bucket: bucketKey(entry.provider.id, name),
        limits: entry.free.limits,
        trainsOnData: entry.free.trainsOnData,
        local: false,
      });
    }
  }

  // Local runtimes are the floor of the pool: no key, no quota, and therefore
  // the only members that cannot be exhausted. They come last because they are
  // slower and usually weaker, not because they are less reliable.
  return [...candidates, ...(await localCandidates(registry, opts))];
}

/** Whether this credential is enough to build the provider's endpoint. */
function callable(provider: Provider, credentials: Credentials, env?: NodeJS.ProcessEnv): boolean {
  if (!templatedBaseUrl(provider.baseUrl)) return true;
  try {
    expandBaseUrl(provider.baseUrl ?? '', credentials, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whatever a local runtime is actually serving right now.
 *
 * There is no list to rank: the models are whichever ones the user has pulled,
 * and asking is the only way to find out. A runtime that is not running is not
 * an error - it is simply not one of today's options.
 */
async function localCandidates(
  registry: ProviderRegistry,
  opts: PoolOptions,
): Promise<PoolCandidate[]> {
  const out: PoolCandidate[] = [];
  for (const free of opts.tiers ?? FREE_TIERS) {
    if (!LOCAL_TIERS.has(free.providerId)) continue;
    const provider = registry.get(free.providerId);
    if (!provider?.fetchModels) continue;

    const models = await provider
      .fetchModels({
        credentials: { type: 'ambient' },
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      })
      .catch(() => []);

    for (const model of models) {
      if (!model.capabilities.tools) continue;
      out.push({
        provider,
        model,
        credentials: { type: 'ambient' },
        account: DEFAULT_ACCOUNT,
        bucket: bucketKey(provider.id, DEFAULT_ACCOUNT),
        limits: {},
        trainsOnData: false,
        local: true,
      });
    }
  }
  return out;
}

/**
 * Free listings that have to be asked for rather than read from the catalog.
 *
 * Cached behind the fetch, so in the common case this is a file read rather
 * than a network call on every lookup.
 */
async function liveListings(
  opts: PoolOptions,
): Promise<Record<string, Array<Model & { tier: PoolTier }>>> {
  const out: Record<string, Array<Model & { tier: PoolTier }>> = {};
  for (const free of opts.tiers ?? FREE_TIERS) {
    if (free.live === 'openrouter-pricing') out[free.providerId] = await openrouterFreeModels();
  }
  return out;
}
