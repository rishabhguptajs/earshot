# Roadmap

Honest state of the project. Nothing here is marked done until it works and has
tests.

## M0 — Scaffold ✅

Bun workspace monorepo, TypeScript project references, biome, CI on macOS, Linux
and Windows, `Bun.build` bundling, `earshot --version`.

## M1 — Provider layer ✅

- Unified message, request and stream-event types
- One bridge to the AI SDK's `LanguageModelV4` spec, shared by every adapter
- 7 wire adapters, 19 providers, 896 models
- models.dev catalog, pruned at build time; live refresh
- Auth store (`0600`, atomic) and the CLI → env → file → ambient resolution order
- Cost accounting including prompt caching
- `earshot models`, `earshot -p`
- Conformance suite covering every adapter through the shared bridge

**Not done in M1:** the ChatGPT sign-in (`openai-codex-responses`) provider, and
Ollama's native adapter — Ollama currently uses the OpenAI-compatible endpoint,
which drops tool calls when streaming.

**Caveat:** no provider has been verified against a live API. Tests run against
scripted provider output.

## M2 — Coding agent ✅

The milestone that makes earshot usable.

- Agent loop: assemble → stream → tool calls → permission gate → execute → repeat.
  `runTurn()` is an async generator, interruptible via `AbortSignal`; read-only
  calls run concurrently, mutating ones serialised in emission order
- Steering: a message typed mid-turn is injected at the next model call rather
  than cancelling the turn
- Tools: `read`, `write`, `edit`, `multi_edit`, `ls`, `glob`, `grep`, `bash`,
  `bash_output`, `web_fetch`, `ask_user`, `todo`
- Permissions: modes `plan | ask | accept-edits | auto | yolo`; `Tool(pattern)`
  rules at global, project and local scope; deny-first and never overridable by
  allow; writes outside cwd always ask; command rules match every segment of a
  chained command, not just its prefix
- Sessions: tree-structured JSONL under the data dir, `--resume`, `--continue`
- `AGENTS.md` loading (and `CLAUDE.md`), nearest-wins by ordering
- Ink TUI: inline scrollback via `Static`, permission and question prompts, diff
  view, collapsible tool blocks, status line
- Undo: per-tool-batch snapshots in a shadow git object store, outside the user's
  repository

**Decision taken:** Windows requires Git Bash. `bash` resolves Git for Windows
and fails with an install pointer when it is absent, rather than falling back to
PowerShell. Two shell dialects would mean quoting, pipelines and permission-rule
matching all differ by machine for the tool the agent uses most.

**Not done in M2:** context shapers and auto-compaction (M3), `/fork` and
`/rewind` commands — the transcript format supports them but no UI drives them
yet — and a `/undo` command, though the snapshots it needs are being written.

**Caveat:** still not verified against a live API. Tests run the whole loop
against a scripted provider.

## M3 — Listening + context ⬜

The [twelve behaviours](listening.md), plus context shapers, auto-compaction at
~80% of the window, the memory system with capture UI, and cost tracking in the
status line.

## M4 — Extensibility ⬜

Agent Skills (`SKILL.md`), slash commands, hooks with a Claude-Code-compatible
JSON contract, MCP client (stdio + streamable HTTP), subagents, headless JSON
output, OAuth flows (OpenRouter PKCE, ChatGPT sign-in), and the remaining
providers.

## M5 — Ship ⬜

Docs site, `npm i -g earshot`, compiled binaries (macOS arm64/x64, Linux
x64/arm64, Windows x64), `/doctor`, Windows QA in Windows Terminal, changelog,
contributor guide.

**Target:** adding an OpenAI-compatible vendor takes ≤30 lines. Currently 1.

## M6 — v1.x ⬜

ACP server (Zed, JetBrains, Neovim), in-process TypeScript extensions, image
input, Anthropic server-side compaction, tool search for large MCP sets.

## Explicitly out of scope

- **Subscription workarounds.** No Claude Pro/Max OAuth, no Gemini Code Assist
  OAuth, nothing that circumvents a provider's terms. See
  [Providers](providers.md#deliberately-not-supported).
- **A web UI.** earshot is a terminal tool. The ACP server covers editors.
- **Model hosting or fine-tuning.** Not this project.
- **Telemetry.** Zero, with an optional local usage log.

## Where help is most useful

1. **Live provider testing.** The single biggest gap. If you have a key for
   anything, run a turn and report what breaks.
2. **Adding providers** — [usually one line](adding-a-provider.md).
3. **Windows testing.** CI covers it; real terminals are another matter.
4. **M2 tools.** Self-contained, well-specified, easy to review.
