# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [Semantic Versioning](https://semver.org/) from its first release.

## [Unreleased]

Nothing queued yet.

## [0.1.0] - 2026-09-06

The first release. Pre-1.0 deliberately: the v1 compatibility guarantees are M7
work and are not met, so a 1.0.0 would promise stability this release does not
have. Headless output and ACP already carry their own version markers and their
own promises - see [Compatibility](docs/compatibility.md).

### Added

- **Ship pipeline** — a VitePress documentation site, verified `npm install -g`
  tarball, npm provenance publishing, and standalone executables for macOS
  arm64/x64, Linux x64/arm64, and Windows x64.
- **`earshot doctor`** — runtime, shell, Git, writable-state, settings, and
  credential-file permission diagnostics that never print a secret.
- **Release QA** — native CI smoke tests for every binary and a human Windows
  Terminal acceptance checklist.

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

### Fixed

- **Session repair on resume** — a session killed mid-turn could leave tool calls
  with no result parts, which a provider rejects, so `--resume` failed on the
  first turn before the user had done anything. Resuming now appends results for
  the unanswered calls and reports that it did. The repair is an append like
  every other change to a transcript; the abandoned turn stays on disk exactly as
  the crash left it. The synthesised results report the outcome as *unknown*
  rather than as a failure, because a process killed after a write completed
  still wrote the file.
- **`/undo` reaching into another session** — the snapshot store is keyed by
  working directory, so undo stepped back through whatever was most recent in the
  directory. After a crash and a resume that meant reverting a batch the user had
  never watched run. Snapshots now record the session that took them and undo is
  scoped to it.
- **Windows CI** — `earshot doctor`'s injected platform did not reach shell
  resolution, so a test naming Linux took the Git Bash branch on the Windows
  runner. Two further failures in the npm smoke test, which had only ever run on
  POSIX, were behind it. The shipped binary was unaffected on all three.

### Changed

- **Undo history from before this release is unreachable.** Existing snapshots
  record no session, and crediting them to whoever asks is the bug above. They
  remain on disk and nothing is deleted.
- **The v1 compatibility contract is written down and tested** — see
  [Compatibility](docs/compatibility.md). Record types and field names for
  `earshot.v1` are locked against the reference documentation in both directions,
  so a rename fails a test while an addition does not. ACP now rejects
  client-provided MCP servers with a reason the client can read; it previously
  threw a plain error that JSON-RPC reported as "Internal error".

### Known limitations

- Provider conformance is tested with scripted output; live behaviour still
  needs coverage for each provider/model combination.
- Windows CI runs natively, but a release still requires the hands-on Windows
  Terminal checklist in [the release guide](docs/release.md).
- Configuration, the transcript format and the extension API carry no version
  marker and no compatibility promise yet; see
  [Compatibility](docs/compatibility.md).
- Editor integration over ACP is covered by protocol tests; the hands-on Zed,
  JetBrains and Neovim checklist in [ACP](docs/acp.md) is not yet recorded.
- A stdio MCP server occasionally fails to start on Windows with a socket error
  from the spawn itself, roughly once in a dozen runs. It surfaces as
  `mcp server "<name>" failed to start` and starting it again succeeds; it is
  not a hang or a silent degradation. The cause is below earshot, in process
  spawning, and is not reproducible on demand.
- ChatGPT subscription sign-in for Codex models is deliberately unsupported;
  use an OpenAI API key. This is a product boundary, not a planned workaround.
