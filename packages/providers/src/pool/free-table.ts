import type { QuotaLimits } from './ledger.ts';

/**
 * The free tiers earshot knows how to pool.
 *
 * This table holds *policy* - which providers have a usable free tier, roughly
 * what it allows, whether they train on what you send, and where to go to get a
 * key. It deliberately does not hold the truth about either number in it:
 *
 *   - Published limits are estimates. They differ per model, change without
 *     notice, and several vendors do not document them at all. They are a
 *     starting point for pacing; a real 429 narrows them at runtime and always
 *     wins (see `QuotaLedger.recordRateLimit`).
 *   - Model lists rot fast. Free model ids are checked against the catalog
 *     before use and skipped if they have gone, because they do go: a snapshot
 *     five days old already named three OpenRouter free models that no longer
 *     existed.
 *
 * `providerId` must name an entry in `SUPPORTED_PROVIDERS`, so pooling a vendor
 * never needs a new wire adapter - which is the point of the provider layer.
 */
export interface FreeTier {
  providerId: string;
  label: string;
  /** Where a human goes to get a key. Opened by the setup wizard. */
  signupUrl: string;
  /** Starting estimates, per account. Narrowed at runtime. */
  limits: QuotaLimits;
  /**
   * Whether the free tier is documented as using submitted data for training.
   * earshot reads private source code, so this is shown, not buried - but it
   * does not restrict routing. That is the user's call to make.
   */
  trainsOnData: boolean;
  /**
   * Free model ids in preference order, best first. Ids that no longer exist in
   * the catalog are skipped rather than fatal.
   */
  models: FreeModel[];
  /** Resolves free models live instead of trusting the catalog. */
  live?: 'openrouter-pricing';
  notice?: string;
}

export interface FreeModel {
  id: string;
  /**
   * Which intent this model serves. `best` is not "highest benchmark score":
   * an agent loop lives on reliable tool calls, and a fast model that fabricates
   * tool arguments is worse than no model at all.
   */
  tier: 'best' | 'fast' | 'cheap';
}

export const FREE_TIERS: FreeTier[] = [
  {
    providerId: 'groq',
    label: 'Groq',
    signupUrl: 'https://console.groq.com/keys',
    limits: { rpm: 30, rpd: 14_400, tpm: 12_000 },
    trainsOnData: false,
    models: [
      { id: 'openai/gpt-oss-120b', tier: 'best' },
      { id: 'llama-3.3-70b-versatile', tier: 'fast' },
      { id: 'openai/gpt-oss-20b', tier: 'fast' },
      { id: 'llama-3.1-8b-instant', tier: 'cheap' },
    ],
  },
  {
    providerId: 'cerebras',
    label: 'Cerebras',
    signupUrl: 'https://cloud.cerebras.ai',
    limits: { rpm: 30, rpd: 14_400, tpm: 60_000 },
    trainsOnData: false,
    models: [
      { id: 'gpt-oss-120b', tier: 'best' },
      { id: 'qwen-3.8-27b', tier: 'fast' },
    ],
  },
  {
    providerId: 'google',
    label: 'Google AI Studio',
    signupUrl: 'https://aistudio.google.com/apikey',
    limits: { rpm: 10, rpd: 250, tpm: 250_000 },
    // Google states the free tier of the Gemini API may be used to improve
    // their products. The paid tier is not. Worth knowing before it reads a
    // private repository.
    trainsOnData: true,
    models: [
      { id: 'gemini-3.5-flash', tier: 'best' },
      { id: 'gemini-flash-latest', tier: 'fast' },
      { id: 'gemini-2.5-flash', tier: 'fast' },
      { id: 'gemini-2.5-flash-lite', tier: 'cheap' },
      { id: 'gemma-4-31b-it', tier: 'cheap' },
    ],
  },
  {
    providerId: 'mistral',
    label: 'Mistral',
    signupUrl: 'https://console.mistral.ai/api-keys',
    limits: { rpm: 60, rpd: 500_000, tpm: 500_000 },
    // Mistral's free "experiment" tier is conditional on data being usable for
    // training; their paid plans are not.
    trainsOnData: true,
    models: [
      { id: 'devstral-medium-2507', tier: 'best' },
      { id: 'mistral-small-latest', tier: 'fast' },
      { id: 'ministral-8b-latest', tier: 'cheap' },
    ],
  },
  {
    providerId: 'openrouter',
    label: 'OpenRouter',
    signupUrl: 'https://openrouter.ai/keys',
    limits: { rpm: 20, rpd: 50 },
    trainsOnData: false,
    // Which OpenRouter models are free changes weekly, so the list is resolved
    // from the live catalog rather than written down here.
    live: 'openrouter-pricing',
    models: [],
    notice: 'free daily requests rise from 50 to 1000 once an account holds $10 of credit.',
  },
  {
    providerId: 'nvidia',
    label: 'NVIDIA NIM',
    signupUrl: 'https://build.nvidia.com',
    // NIM's hosted endpoints are free to call while an account has credits, and
    // a new account is granted them on signup. Cloud credits are consumed rather
    // than a request count reset daily, so there is no honest rpd to publish -
    // the ledger learns the real ceiling from the 429 when it arrives.
    limits: { rpm: 40 },
    trainsOnData: false,
    models: [
      { id: 'deepseek-ai/deepseek-v4-pro-0813', tier: 'best' },
      { id: 'moonshotai/kimi-k3', tier: 'best' },
      { id: 'moonshotai/kimi-k2.6', tier: 'fast' },
      { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', tier: 'fast' },
      { id: 'openai/gpt-oss-20b', tier: 'cheap' },
    ],
    notice: 'hosted NIM endpoints draw on signup credits rather than a daily request count.',
  },
  {
    providerId: 'cloudflare',
    label: 'Cloudflare Workers AI',
    signupUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
    // Workers AI meters in "neurons", not requests: the free allocation is
    // 10,000 a day, and what one request costs depends on the model and the
    // length of the turn. A coding turn is expensive in those terms, so the
    // request estimate here is deliberately low - it is a pacing hint, and the
    // ledger narrows it the first time Cloudflare says otherwise.
    limits: { rpm: 30, rpd: 150 },
    trainsOnData: false,
    models: [
      { id: '@cf/zai-org/glm-4.7-flash', tier: 'best' },
      { id: '@cf/openai/gpt-oss-120b', tier: 'best' },
      { id: '@cf/openai/gpt-oss-20b', tier: 'fast' },
      { id: '@cf/ibm-granite/granite-4.0-h-micro', tier: 'cheap' },
    ],
    notice:
      'the free tier is 10,000 neurons/day, which a long coding turn can spend quickly. ' +
      'connecting it needs your account id as well as a token.',
  },
  {
    providerId: 'together',
    label: 'Together AI',
    signupUrl: 'https://api.together.xyz/settings/api-keys',
    limits: { rpm: 60, rpd: 1_000 },
    trainsOnData: false,
    models: [{ id: 'openai/gpt-oss-20b', tier: 'cheap' }],
  },
  // Local runtimes are the floor of the pool: no quota, no key, no network, and
  // therefore the only member that cannot be exhausted. They are reached only
  // when every metered tier is spent.
  {
    providerId: 'ollama',
    label: 'Ollama (local)',
    signupUrl: 'https://ollama.com/download',
    limits: {},
    trainsOnData: false,
    models: [],
  },
  {
    providerId: 'lmstudio',
    label: 'LM Studio (local)',
    signupUrl: 'https://lmstudio.ai',
    limits: {},
    trainsOnData: false,
    models: [],
  },
];

export const LOCAL_TIERS = new Set(['ollama', 'lmstudio']);

export const freeTier = (providerId: string): FreeTier | undefined =>
  FREE_TIERS.find((tier) => tier.providerId === providerId);
