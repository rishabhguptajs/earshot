# Providers

19 providers ship in the box. Model metadata — context windows, pricing,
capabilities — comes from the [models.dev](https://models.dev) registry, pruned at
build time to the providers earshot supports.

Run `earshot models` for the live list; the table below is the shape of it.

## Built in

| id | Name | Models | Credentials | Wire adapter |
|---|---|---:|---|---|
| `anthropic` | Anthropic | 14 | `ANTHROPIC_API_KEY` | `anthropic-messages` |
| `openai` | OpenAI | 42 | `OPENAI_API_KEY` | `openai-responses` |
| `google` | Google | 32 | `GOOGLE_API_KEY`<br>`GOOGLE_GENERATIVE_AI_API_KEY`<br>`GEMINI_API_KEY` | `google-generative-ai` |
| `bedrock` | Amazon Bedrock | 123 | *ambient* | `bedrock-converse` |
| `vertex` | Vertex | 43 | *ambient* | `google-vertex` |
| `azure` | Azure | 83 | `AZURE_RESOURCE_NAME`<br>`AZURE_API_KEY` | `azure-openai` |
| `openrouter` | OpenRouter | 357 | `OPENROUTER_API_KEY` | `openai-completions` |
| `groq` | Groq | 12 | `GROQ_API_KEY` | `openai-completions` |
| `deepseek` | DeepSeek | 3 | `DEEPSEEK_API_KEY` | `openai-completions` |
| `xai` | xAI | 7 | `XAI_API_KEY` | `openai-completions` |
| `mistral` | Mistral | 32 | `MISTRAL_API_KEY` | `openai-completions` |
| `together` | Together AI | 38 | `TOGETHER_API_KEY` | `openai-completions` |
| `fireworks` | Fireworks AI | 19 | `FIREWORKS_API_KEY` | `openai-completions` |
| `cerebras` | Cerebras | 2 | `CEREBRAS_API_KEY` | `openai-completions` |
| `deepinfra` | Deep Infra | 62 | `DEEPINFRA_API_KEY` | `openai-completions` |
| `nebius` | Nebius Token Factory | 17 | `NEBIUS_API_KEY` | `openai-completions` |
| `llama` | Llama | 7 | `LLAMA_API_KEY` | `openai-completions` |
| `lmstudio` | LMStudio | 3 | *none* | `openai-completions` |
| `ollama` | Ollama | live | *none* | `openai-completions` |

Model counts come from the vendored catalog snapshot and shift as vendors publish.
Ollama discovers models live from whatever you have pulled.

## How credentials resolve

First match wins:

1. **CLI flag** — `--api-key`
2. **Environment variable** — the ones in the table above
3. **Auth file** — `~/.config/earshot/auth.json`, written atomically, mode `0600` on POSIX
4. **Ambient credentials** — the AWS credential chain for Bedrock, Google
   Application Default Credentials for Vertex

On Windows the config directory is `%APPDATA%\earshot`. Override it with
`EARSHOT_CONFIG_DIR`.

If nothing resolves, earshot exits **3** and names the variable to set, rather
than failing later at request time with a provider's own error.

## Wire adapters

A wire adapter is the only thing that speaks HTTP. Seven ship:

| Adapter | Serves |
|---|---|
| `anthropic-messages` | Anthropic |
| `openai-responses` | OpenAI |
| `google-generative-ai` | Google |
| `bedrock-converse` | Amazon Bedrock (SigV4 via the AWS credential chain) |
| `google-vertex` | Vertex (Application Default Credentials) |
| `azure-openai` | Azure OpenAI |
| `openai-completions` | **Everything else** — every OpenAI-compatible vendor |

`openai-completions` is the workhorse: OpenRouter, Groq, DeepSeek, xAI, Mistral,
Together, Fireworks, Cerebras, DeepInfra, Nebius, Llama, LM Studio, Ollama, and
any endpoint you hand a base URL. This is why adding a provider is usually a
one-line change — see [Adding a provider](adding-a-provider.md).

## Custom and local endpoints

Any OpenAI-compatible server works with no code change — vLLM, llama.cpp, a
corporate gateway, or a model the catalog doesn't know yet:

```ts
customProvider({
  id: 'my-vllm',
  baseUrl: 'http://gpu-box:8000/v1',
  apiKeyEnv: 'MY_VLLM_KEY', // optional
  models: [{ id: 'qwen3-coder', context: 256_000 }],
});
```

## Known provider quirks

These are real constraints, encoded in the design rather than discovered at
runtime. [Architecture](architecture.md#provider-quirks) covers how each is handled.

| Provider | Quirk | Consequence |
|---|---|---|
| Anthropic | History is append-only; edited history with thinking blocks is rejected | The transcript never mutates; compaction appends |
| OpenAI | Reasoning must be replayed as encrypted content | Reasoning metadata is persisted verbatim |
| Gemini 3 | `thought_signature` must round-trip on function-call parts | Same mechanism |
| Ollama | The OpenAI-compatible `/v1` drops tool calls when streaming | Flagged on the provider; native adapter planned |
| LM Studio | No streaming tool calls | Flagged; buffered fallback planned |

## Deliberately not supported

Not oversights — each is a decision:

- **Claude Pro/Max subscriptions.** Anthropic's terms prohibit subscription OAuth
  outside Claude.ai and Claude Code, and it is enforced at the infrastructure
  level. Use an API key, Bedrock, or Vertex. earshot will not ship a workaround,
  and PRs adding one will be declined.
- **Gemini Code Assist OAuth.** Banned, and the endpoint is deprecated.
- **GitHub Copilot subscriptions.** No official third-party inference path exists.
- **ChatGPT sign-in for Codex models.** Legally gray rather than prohibited.
  Planned as an isolated, clearly labelled, easily removed provider — not yet built.

## Refreshing the catalog

```bash
earshot models --refresh          # fetch live from models.dev
bun run scripts/fetch-catalog.ts  # regenerate the vendored snapshot
```

The snapshot is pruned from models.dev's 4.4 MB down to ~380 kB: only supported
providers, only the fields the harness reads, and only text-output chat models.
Image and audio models arrive with no context limits and would ship as broken
entries, so they are dropped.
