/**
 * The unified wire model. Everything above this file (agent loop, TUI, sessions)
 * speaks only these types; each provider adapter translates them to and from its
 * own API. Provider-specific data that must survive a round-trip (OpenAI encrypted
 * reasoning, Gemini thought signatures, Anthropic cache breakpoints) rides along
 * opaquely in `providerMetadata` and is persisted verbatim in the transcript.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/**
 * Namespaced by provider id. JSON-valued by construction: this is written to and
 * read back from the session JSONL verbatim, so anything unserialisable here would
 * silently break replay. Values may be `undefined` - providers do emit sparse
 * objects, and JSON.stringify drops those keys, which is the behaviour we want.
 */
export type ProviderMetadata = Record<string, Record<string, JsonValue | undefined>>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
  providerMetadata?: ProviderMetadata;
}

/** Model-emitted thinking. `text` may be redacted/empty when the provider only
 *  returns an opaque blob; the blob lives in providerMetadata and must be replayed. */
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  providerMetadata?: ProviderMetadata;
}

export interface ImagePart {
  type: 'image';
  /** base64 payload or an https URL */
  data: string;
  mediaType: string;
  providerMetadata?: ProviderMetadata;
}

export interface ToolCallPart {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerMetadata?: ProviderMetadata;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
  isError?: boolean;
  providerMetadata?: ProviderMetadata;
}

export type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'content'; value: Array<TextPart | ImagePart> };

export type MessagePart = TextPart | ReasoningPart | ImagePart | ToolCallPart | ToolResultPart;

export interface Message {
  role: Role;
  content: MessagePart[];
  providerMetadata?: ProviderMetadata;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export interface ModelRequest {
  modelId: string;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  abortSignal?: AbortSignal;
  /** Escape hatch: merged into the provider payload after transforms. */
  providerOptions?: ProviderMetadata;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'refusal'
  | 'abort'
  | 'error';

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string; providerMetadata?: ProviderMetadata }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string }
  | { type: 'tool_call_delta'; toolCallId: string; argsTextDelta: string }
  | {
      type: 'tool_call_end';
      toolCallId: string;
      toolName: string;
      input: unknown;
      providerMetadata?: ProviderMetadata;
    }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'finish';
      reason: FinishReason;
      usage: Usage;
      /** The fully assembled assistant message, ready to append to history. */
      message: Message;
    }
  | { type: 'error'; error: EarshotError };

export interface EarshotError {
  kind:
    | 'auth'
    | 'rate_limit'
    | 'context_overflow'
    | 'invalid_request'
    | 'server'
    | 'network'
    | 'abort'
    | 'unknown';
  message: string;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

// ---------------------------------------------------------------------------
// Models and providers
// ---------------------------------------------------------------------------

export interface ModelCost {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  /** Provider requires reasoning blocks to be replayed verbatim. */
  reasoningReplay?: boolean;
}

export interface Model {
  id: string;
  providerId: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  cost?: ModelCost;
  capabilities: ModelCapabilities;
  /** Which wire adapter serves this model. */
  api: WireApiKind;
  releaseDate?: string;
}

export type WireApiKind =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-completions'
  | 'openai-codex-responses'
  | 'google-generative-ai'
  | 'google-vertex'
  | 'bedrock-converse'
  | 'azure-openai'
  | 'ollama-native';

/** How credentials are obtained for a provider. */
export type AuthSpec =
  | { kind: 'none' }
  | { kind: 'api-key'; envVars: string[]; helpUrl?: string }
  | { kind: 'oauth'; flow: 'pkce'; envVars?: string[]; helpUrl?: string }
  | { kind: 'ambient'; description: string };

export interface Credentials {
  type: 'api-key' | 'oauth' | 'ambient';
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

/** A wire adapter: the only thing that actually talks HTTP. */
export interface WireApi {
  kind: WireApiKind;
  stream(req: ModelRequest, ctx: WireContext): AsyncIterable<StreamEvent>;
}

export interface WireContext {
  baseUrl?: string;
  credentials: Credentials;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** A request transform, applied in order before the wire adapter sees the request. */
export interface Transform {
  name: string;
  apply(req: ModelRequest, model: Model): ModelRequest;
}

export interface Provider {
  id: string;
  name: string;
  auth: AuthSpec;
  /** Default base URL; overridable per provider in config. */
  baseUrl?: string;
  api: WireApiKind | ((model: Model) => WireApiKind);
  models(): Model[];
  /** Live model discovery (Ollama /api/tags, OpenRouter /models, ...). */
  fetchModels?(ctx: WireContext): Promise<Model[]>;
  transforms?: Transform[];
  /** Shown in the TUI when the provider is unofficial or best-effort. */
  notice?: string;
}
