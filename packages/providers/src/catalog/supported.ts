import type { WireApiKind } from '../types.ts';

/**
 * The provider table. Adding a vendor is an entry here plus, if it is not already
 * OpenAI-compatible, a wire adapter - which is the whole point of the layer.
 *
 * `catalogId` is the models.dev provider id the snapshot is pruned to. `baseUrl`
 * is only needed where models.dev has no `api` field for the provider.
 */
export interface SupportedProvider {
  id: string;
  catalogId: string;
  api: WireApiKind;
  /** Overrides the catalog's `api` field. */
  baseUrl?: string;
  /** Overrides the catalog's `env` list. */
  envVars?: string[];
  /**
   * Values other than the key that the base URL needs, named by environment
   * variable. Cloudflare puts the account id in the path, so a key alone cannot
   * address the endpoint; `${NAME}` in a base URL is filled from the stored
   * credential first and the environment second.
   */
  extraEnv?: Array<{ name: string; label: string; hint?: string }>;
  auth?: 'api-key' | 'oauth' | 'ambient' | 'none';
  notice?: string;
}

export const SUPPORTED_PROVIDERS: SupportedProvider[] = [
  // --- first-class adapters -------------------------------------------------
  { id: 'anthropic', catalogId: 'anthropic', api: 'anthropic-messages' },
  { id: 'openai', catalogId: 'openai', api: 'openai-responses' },
  { id: 'google', catalogId: 'google', api: 'google-generative-ai' },

  // --- ambient-credential clouds -------------------------------------------
  { id: 'bedrock', catalogId: 'amazon-bedrock', api: 'bedrock-converse', auth: 'ambient' },
  { id: 'vertex', catalogId: 'google-vertex', api: 'google-vertex', auth: 'ambient' },
  { id: 'azure', catalogId: 'azure', api: 'azure-openai' },

  // --- OpenAI-compatible vendors: a base URL and an env var, nothing more ---
  // OpenRouter publishes a PKCE flow for third-party apps: `earshot auth login
  // openrouter` uses it, and an API key still works exactly as before.
  { id: 'openrouter', catalogId: 'openrouter', api: 'openai-completions', auth: 'oauth' },
  {
    id: 'groq',
    catalogId: 'groq',
    api: 'openai-completions',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  { id: 'deepseek', catalogId: 'deepseek', api: 'openai-completions' },
  { id: 'xai', catalogId: 'xai', api: 'openai-completions', baseUrl: 'https://api.x.ai/v1' },
  {
    id: 'mistral',
    catalogId: 'mistral',
    api: 'openai-completions',
    baseUrl: 'https://api.mistral.ai/v1',
  },
  {
    id: 'together',
    catalogId: 'togetherai',
    api: 'openai-completions',
    baseUrl: 'https://api.together.xyz/v1',
  },
  { id: 'fireworks', catalogId: 'fireworks-ai', api: 'openai-completions' },
  {
    id: 'cerebras',
    catalogId: 'cerebras',
    api: 'openai-completions',
    baseUrl: 'https://api.cerebras.ai/v1',
  },
  {
    id: 'deepinfra',
    catalogId: 'deepinfra',
    api: 'openai-completions',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
  },
  { id: 'nebius', catalogId: 'nebius', api: 'openai-completions' },
  {
    id: 'nvidia',
    catalogId: 'nvidia',
    api: 'openai-completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  // Workers AI addresses an account, not just a key: the account id is a path
  // segment. `${CLOUDFLARE_ACCOUNT_ID}` is expanded per credential at call time,
  // and the env list is narrowed to the token so the account id is never
  // mistaken for one.
  {
    id: 'cloudflare',
    catalogId: 'cloudflare-workers-ai',
    api: 'openai-completions',
    // The placeholder is the point: it is expanded per credential by
    // `expandBaseUrl`, and this is the spelling models.dev publishes.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded at call time
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    envVars: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'],
    extraEnv: [
      {
        name: 'CLOUDFLARE_ACCOUNT_ID',
        label: 'Cloudflare account id',
        hint: 'the 32-character id on your Workers & Pages overview page',
      },
    ],
  },
  { id: 'llama', catalogId: 'llama', api: 'openai-completions' },

  // --- local runtimes -------------------------------------------------------
  {
    id: 'lmstudio',
    catalogId: 'lmstudio',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1234/v1',
    auth: 'none',
    notice: 'LM Studio does not stream tool calls; earshot falls back to a buffered call.',
  },
];

export const SUPPORTED_PROVIDER_IDS: string[] = [
  ...new Set(SUPPORTED_PROVIDERS.map((p) => p.catalogId)),
];
