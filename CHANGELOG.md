# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [Semantic Versioning](https://semver.org/) from its first release.

## [Unreleased]

## [0.5.1] - 2026-09-09

### Fixed

- **Enabling the pool now actually switches sessions to it.** `loadSettings`
  lets the narrowest scope win for `defaultModel`, so a model the first-run
  picker had saved into `./.earshot/settings.json` kept beating the `free/best`
  that `pool setup` wrote to the global file - the pool was on, seven providers
  were connected, and every session still started on `openrouter/free`.
  `earshot pool enable`, the wizard's finish and `/pool on` now rewrite every
  scope that pins a model, and say which files they touched. `earshot doctor`
  warns when it finds the pool on and a narrower file still pinning one.
- The status line names the tier as well as the member serving it
  (`free/best · groq/openai/gpt-oss-120b`), so a pooled session no longer looks
  like a session on one vendor.
- The free-tier table was checked against each vendor's live model list and
  published limits: Groq's retired Llama endpoints are replaced by its Qwen 3.x
  models and its limits corrected to 1,000 requests and 200k tokens a day;
  Mistral's `devstral-medium-2507` is gone and `mistral-medium-latest` takes
  its place; Cerebras and Together AI are dropped from the pool, Cerebras
  because its trial credits now need a payment method on file and Together
  because it withdrew its free tier. NVIDIA's hosted endpoints no longer meter credits, and the notice says so.

## [0.5.0] - 2026-09-09

### Added

- **NVIDIA NIM and Cloudflare Workers AI join the free pool.** Both are
  OpenAI-compatible, so neither needed a wire adapter - only a provider-table
  entry, a free-tier entry, and a catalog refresh that puts their models in the
  pruned snapshot.
- Provider base URLs may now carry `${NAME}` placeholders, filled per credential
  and falling back to the environment. Cloudflare Workers AI puts the account id
  in its path, which makes the endpoint a property of the *account* rather than
  the provider - so two pooled Cloudflare accounts are two endpoints, and a
  missing value fails at resolve time with the name of what is missing - exit 3,
  like any other missing credential - instead of a 404 against a URL containing
  a literal `${...}`. In the pool, an account that cannot address an endpoint is
  skipped rather than routed to, the same as a model a vendor has retired.
- `earshot pool setup` asks for the extra values an endpoint needs after the key,
  shown as typed rather than as bullets: an account id is an identifier, not a
  secret, and hiding it only stops you checking you pasted the right one. Nothing
  is stored until every value is in hand.

### Changed

- Refreshed the vendored models.dev snapshot. `cerebras/gemma-4-31b` had been
  retired and is replaced in the free table by `cerebras/qwen-3.8-27b`.

### Not added

- **GitHub Models.** It is being retired: both its catalog and inference
  endpoints return HTTP 410 (`github_models_retirement_brownout`). Pooling it
  would ship a provider that is scheduled to stop answering.


### Added

- **Free provider pool.** A dozen vendors give away real capacity, and any one
  of those free tiers is too small to code against; pooled, they are not.
  `earshot pool setup` connects them once, and `free/best`, `free/fast` and
  `free/cheap` route across whatever is connected and still has quota.
- Quota is paced locally, so a spent tier costs nothing rather than a failed
  round trip. Published limits are treated as estimates: a 429 parks the account
  and narrows the ceiling earshot believes in.
- Several named accounts per provider, because free tiers meter per account -
  a second key from the same login shares its bucket.
- Failover retries the same account before moving on, and never switches
  mid-stream: past the first token the step belongs to that model. Swaps are
  announced, shown in the status line, and written to the transcript.
- OpenRouter's free models are resolved live and filtered on price rather than
  the `:free` suffix, which is neither necessary nor sufficient.
- Local runtimes (Ollama, LM Studio) join as the floor of the pool: no key, no
  quota, reached once every metered account is spent.
- Free tiers documented as training on submitted data are marked as such in the
  wizard and in `earshot pool status`, and can be excluded outright.
- `earshot pool add-endpoint` points earshot at any OpenAI-compatible URL.
  earshot ships no unofficial providers; this is the door for anyone who wants
  one anyway.
- `/pool` shows quota and connects providers without leaving a session.
- `earshot doctor` now warns when the configured default model has been retired.

### Changed

- `/model` asks where to save the choice - everywhere, or this project only -
  and the confirmation names the file it wrote. It previously wrote
  project-scoped settings silently, so a model chosen in one directory reverted
  to the stale global default in every other one, with nothing said about it.
  The undocumented `ctrl+g` and `g` accelerators are gone.
- Compaction and subagents run on `free/cheap` in a pooled session, keeping the
  better tiers' quota for the conversation.

### Fixed

- `/reasoning on|off` forces reasoning for a model regardless of what the
  catalog claims it supports. The catalog goes stale in both directions, and
  `/reasoning` previously refused to act at all on a model it thought could not
  reason - leaving no way out of a provider rejecting a parameter it is listed
  as accepting.

## [0.4.2] - 2026-09-08

### Fixed

- Made install-path URL conversion depend on the described target platform
  rather than the host running detection, and stabilized onboarding input tests
  on slower Windows runners.

## [0.4.1] - 2026-09-08

### Fixed

- Made npm-install detection path-separator neutral, so `earshot update` works
  and its install detection tests pass on Windows as well as macOS and Linux.

## [0.4.0] - 2026-09-08

### Added

- Persistent global and project model preferences, plus per-model reasoning
  effort with `/reasoning` and `--reasoning-effort` controls.
- Searchable saved-chat navigation through both `earshot sessions` and the
  in-session `/sessions` command.
- Immediate animated turn feedback for preparation, thinking, reasoning, and
  tool execution. Streamed reasoning is visible by default and can be toggled
  with `/thinking show|hide`.

### Changed

- Plain `earshot` now starts a new chat, while `--continue`, `--resume`, and the
  session picker explicitly resume existing transcripts.
- `/model` now opens a searchable, credential-aware picker and remembers the
  selected model. Existing credentials are reused without prompting again.
- Model and reasoning changes are recorded as append-only transcript entries,
  preserving compatibility with legacy transcripts.

### Fixed

- Removed the onboarding prompt-entry screen that caused the first user prompt
  to appear and enter model history twice.

## [0.3.2] - 2026-09-06

### Fixed

- **First-run onboarding now uses the provider and model the user selects.**
  Choosing a provider opens a searchable list of its model IDs, reuses an
  existing credential when present, verifies that exact model with the live
  probe, and carries the selected `provider/model` into the new session.
  Previously a successful OpenRouter sign-in still retried the hard-coded
  Anthropic default and immediately failed for lack of Anthropic credentials.

## [0.3.1] - 2026-09-06

### Fixed

- **`earshot update` could not update a standalone binary.** Two faults, both
  found by running a real 0.2.0 binary against the live 0.3.0 release rather
  than against the test doubles, which had passed:

  - The default `fetch` wrapper took only a URL and dropped the `init`
    argument, so every authorization header the code added was silently
    discarded. The injected fetch in the tests honored `init`, so the tests
    could not see it.
  - Assets were fetched from `releases/download/…`, which ignores a bearer
    token and answers 404 for a private repository. They now go through the
    GitHub asset API, which accepts one and behaves identically once the
    repository is public.

  Release requests now send `EARSHOT_GITHUB_TOKEN`, `GITHUB_TOKEN` or
  `GH_TOKEN` when one is set, and a 404 — which is what GitHub returns for
  "private" as well as "missing" — is reported as the missing-token problem it
  usually is instead of as a bare status code.

## [0.3.0] - 2026-09-06

### Added

- **`earshot update`** — one command that updates earshot however it was
  installed, replacing "rerun `npm install -g` and hope" or a manual trip to
  GitHub Releases. It detects the install form first: a standalone binary is a
  Bun `--compile` executable whose entry module lives in Bun's `$bunfs` virtual
  filesystem, which is the only signal that survives the file being renamed or
  symlinked — `process.versions.bun` is set when running from source under Bun
  too, so it cannot be the discriminator.

  An npm install is compared against the registry and, on a global npm tree,
  offers to run the install for you. A bun, pnpm, yarn or Volta tree gets that
  manager's command printed instead and nothing is run: `npm install -g` over
  one of those does not replace the install, it adds a second copy at another
  prefix and leaves PATH order to pick a winner.

  A standalone binary is downloaded, verified against the `SHA256SUMS`
  published with every release, and only then put in place — a mismatch
  replaces nothing. The download lands in the target's own directory so the
  final step is a same-filesystem rename, atomic on POSIX. On Windows, where a
  running `.exe` cannot be deleted or overwritten but can be renamed, the
  running image moves aside to `earshot.exe.old-<pid>` and the next run sweeps
  it up.

  Nothing is downloaded or installed without a confirmation. `--yes` skips it,
  `--check` reports only and exits **4** when an update is available — a new
  exit code, so CI can branch on it without parsing text.

## [0.2.0] - 2026-09-06

### Added

- **First-run onboarding** — starting `earshot` with no credentials configured
  now opens the TUI into an onboarding flow instead of exiting: pick a
  provider, sign in with a browser or paste a key, and one minimal live call
  verifies it before your first turn runs. A rejected key is removed rather
  than left to fail again; an unreachable probe offers keeping the key anyway
  rather than blocking you behind a flaky network. `--no-onboarding` restores
  the previous behavior for scripts and CI. Headless (`-p`) and `earshot acp`
  are unaffected — a missing credential there still exits `3` immediately.
- **A `/` command menu** in the TUI, filtering as you type, with `tab` to
  complete and `enter` to run. Every built-in command now comes from a single
  registry (`packages/tui/src/commands.ts`) that dispatch, the menu, and
  `docs/cli.md` all read from, so a command cannot be documented without being
  runnable or runnable without being documented.
- New in-session commands: `/help`, `/model` (show or switch the model
  mid-session), `/compact` (run compaction early), `/context`, `/cost`,
  `/todo`, `/permissions`, `/init` (write an `AGENTS.md` for the project).

## [0.1.0] - 2026-09-06

The first release. Pre-1.0 deliberately: the v1 compatibility guarantees are M7
work and are not met, so a 1.0.0 would promise stability this release does not
have. Headless output and ACP already carry their own version markers and their
own promises - see [Compatibility](docs/compatibility.md).

Published as `@raegent/earshot`. npm refuses the unscoped name for being too
close to an existing `teashot`; the command is still `earshot`, and only the
install string carries the scope.

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
