# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [Semantic Versioning](https://semver.org/) from its first release.

## [Unreleased]

Pre-alpha. Not yet published to npm.

### Added

- **Provider layer** — 19 providers and 896 models: Anthropic, OpenAI, Google,
  Bedrock, Vertex, Azure, OpenRouter, Groq, DeepSeek, xAI, Mistral, Together,
  Fireworks, Cerebras, DeepInfra, Nebius, Llama, LM Studio and Ollama, plus any
  OpenAI-compatible endpoint.
- **Seven wire adapters** built on one shared bridge to the AI SDK's
  `LanguageModelV4` spec, so every AI SDK provider package becomes an adapter in
  about two lines.
- **Model catalog** from models.dev, pruned at build time from 4.4 MB to ~380 kB,
  with live refresh and user overrides.
- **Credential resolution** — CLI flag, environment variable, `0600` auth file,
  then provider-native ambient credentials (AWS chain, Google ADC).
- **Cost accounting** from catalog pricing, including cache reads and writes.
- `earshot models` — list, filter and refresh the catalog.
- `earshot -p` — a single headless turn, with `text`, `json` and `stream-json`
  output.
- **Live model discovery** for local runtimes: a reference to an Ollama model the
  static catalog never listed resolves by asking the running server, and an
  unreachable server reports "unknown model" rather than failing loudly.
- **Conformance suite** covering every adapter at once through the shared bridge:
  streaming, parallel tool calls, reasoning round-trip, abort, usage, finish
  reasons and error classification.

### Known limitations

- No agent loop, tools, permissions, TUI, sessions, memory, MCP, skills or hooks
  yet — see the [roadmap](docs/roadmap.md).
- **No provider has been verified against a live API.** Tests run against
  scripted provider output.
- Ollama uses the OpenAI-compatible endpoint, which drops tool calls when
  streaming; the native adapter is not built.
- ChatGPT sign-in (`openai-codex-responses`) is not implemented.
