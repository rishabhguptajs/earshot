import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { WireApi, WireContext } from '../types.ts';
import { createAiSdkWire } from './ai-sdk.ts';
import { ollamaNativeWire } from './ollama.ts';

/**
 * Every wire adapter earshot ships. Each is a two-line binding of an AI SDK
 * provider package to the shared bridge, which is what keeps adding a vendor
 * cheap: an OpenAI-compatible vendor needs no adapter at all, only a base URL.
 */

const key = (ctx: WireContext): string =>
  ctx.credentials.apiKey ?? ctx.credentials.accessToken ?? '';

const common = (ctx: WireContext) => ({
  ...(ctx.baseUrl ? { baseURL: ctx.baseUrl } : {}),
  ...(ctx.headers ? { headers: ctx.headers } : {}),
  ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
});

export const anthropicWire: WireApi = createAiSdkWire('anthropic-messages', (modelId, ctx) =>
  createAnthropic({ apiKey: key(ctx), ...common(ctx) })(modelId),
);

export const openaiResponsesWire: WireApi = createAiSdkWire('openai-responses', (modelId, ctx) =>
  createOpenAI({ apiKey: key(ctx), ...common(ctx) }).responses(modelId),
);

export const googleWire: WireApi = createAiSdkWire('google-generative-ai', (modelId, ctx) =>
  createGoogleGenerativeAI({ apiKey: key(ctx), ...common(ctx) })(modelId),
);

/**
 * The workhorse: every OpenAI-compatible vendor (OpenRouter, Groq, DeepSeek, xAI,
 * Mistral, Together, Fireworks, Cerebras, LM Studio, vLLM, llama.cpp, and any
 * custom base URL) runs through this one adapter.
 */
export const openaiCompatibleWire: WireApi = createAiSdkWire(
  'openai-completions',
  (modelId, ctx): LanguageModelV4 => {
    if (!ctx.baseUrl) throw new Error('an OpenAI-compatible provider requires a baseUrl');
    return createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: ctx.baseUrl,
      ...(ctx.credentials.apiKey ? { apiKey: ctx.credentials.apiKey } : {}),
      ...(ctx.headers ? { headers: ctx.headers } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    })(modelId);
  },
);

/** Credentials come from the AWS chain (env, profile, IMDS) when not set explicitly. */
export const bedrockWire: WireApi = createAiSdkWire('bedrock-converse', (modelId, ctx) => {
  const extra = ctx.credentials.extra ?? {};
  return createAmazonBedrock({
    ...(typeof extra.region === 'string' ? { region: extra.region } : {}),
    ...(ctx.credentials.apiKey ? { apiKey: ctx.credentials.apiKey } : {}),
    ...common(ctx),
  })(modelId);
});

/** Uses Google Application Default Credentials when no key is supplied. */
export const vertexWire: WireApi = createAiSdkWire('google-vertex', (modelId, ctx) => {
  const extra = ctx.credentials.extra ?? {};
  return createVertex({
    ...(typeof extra.project === 'string' ? { project: extra.project } : {}),
    ...(typeof extra.location === 'string' ? { location: extra.location } : {}),
    ...common(ctx),
  })(modelId);
});

export const azureWire: WireApi = createAiSdkWire('azure-openai', (modelId, ctx) => {
  const extra = ctx.credentials.extra ?? {};
  return createAzure({
    apiKey: key(ctx),
    ...(typeof extra.resourceName === 'string' ? { resourceName: extra.resourceName } : {}),
    ...common(ctx),
  }).responses(modelId);
});

export const ALL_WIRES: WireApi[] = [
  anthropicWire,
  openaiResponsesWire,
  googleWire,
  openaiCompatibleWire,
  bedrockWire,
  vertexWire,
  azureWire,
  ollamaNativeWire,
];
