# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [Semantic Versioning](https://semver.org/) from its first release.

## [Unreleased]

Pre-alpha. Not yet published to npm.

### Added

- **MCP client** (`packages/mcp`) — stdio and streamable HTTP servers, tools
  namespaced `server__tool` and gated exactly like built-ins. An MCP tool is
  never treated as read-only whatever the server says about itself. A stdio
  server defined in a project's checked-in settings is listed rather than
  started until `earshot mcp trust <name>`.
- **Agent Skills** — `SKILL.md` from the project or the config directory. The
  system prompt carries the index; a body is loaded when it is used.
  `allowed-tools` intersects with the session's tools and can only narrow them,
  and never removes `ask_user`.
- **User-defined slash commands** — `.earshot/commands/<name>.md`, expanded with
  `$ARGUMENTS` and `$1`–`$9` and run as an ordinary prompt. `/skills` lists both.
- **Hooks** — Claude Code's JSON contract over six events. A hook may block a
  call or turn an allow into a prompt; it may never approve one. A hook that
  fails, times out or prints garbage blocks nothing.
- **Subagents** — the `task` tool runs a nested agent with its own context window
  and returns its answer. It inherits the permission rules, the declared scope,
  the approved plan and the cost total; it does not inherit context, the
  transcript, or a `task` tool of its own.
- **Versioned headless output** — `"schema": "earshot.v1"` on every JSON record,
  additive within v1, a new major requested by name. See `docs/headless.md`.
- **`/plan`** — draft a plan in plan mode, edit it in `$EDITOR`, approve it; what
  is pinned for the run is what the file says.
- **Intent line** — a one-line "why" before every tool batch, emitted as an event
  so a batch that arrived without one is visible.
- **`earshot auth`** — `list`, `login` (including OpenRouter's PKCE flow) and
  `logout`.
- **Native Ollama adapter** — `/api/chat` rather than the OpenAI-compatible
  `/v1`, which drops tool calls when streaming.
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
