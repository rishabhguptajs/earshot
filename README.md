<div align="center">

# earshot

**A terminal coding agent that actually listens.**

[![CI](https://github.com/rishabhguptajs/earshot/actions/workflows/ci.yml/badge.svg)](https://github.com/rishabhguptajs/earshot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![Providers](https://img.shields.io/badge/providers-19-orange.svg)](docs/providers.md)

[Quick start](#quick-start) · [Why](#why-another-one) · [Docs](docs/) · [Providers](docs/providers.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](docs/roadmap.md)

</div>

---

> [!WARNING]
> **earshot is pre-alpha and not yet a working coding agent.**
> The provider layer is built and tested: you can list models and run a single
> headless turn against 19 providers. The agent loop, tools, permissions and the
> TUI do not exist yet. See [status](#status) for exactly what works today, and
> the [roadmap](docs/roadmap.md) for what is coming.

## Why another one?

Claude Code, Codex CLI and OpenCode are all good. Each gives you one or two of
the things below. earshot exists because nothing gives you all three.

### 1. Every provider, and adding one is a config entry

19 providers and 896 models ship in the box — Anthropic, OpenAI, Google, Bedrock,
Vertex, Azure, OpenRouter, Groq, DeepSeek, xAI, Mistral, Together, Fireworks,
Cerebras, DeepInfra, Nebius, Llama, LM Studio and Ollama — plus any
OpenAI-compatible endpoint you point it at.

Adding a vendor is one line, because most vendors are OpenAI-compatible:

```ts
{ id: 'groq', catalogId: 'groq', api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1' },
```

Model metadata — context windows, pricing, capabilities — comes from the
[models.dev](https://models.dev) registry rather than a hand-maintained list that
goes stale. See [Adding a provider](docs/adding-a-provider.md).

### 2. A real terminal UX, on Windows too

Claude-Code-style inline scrollback, installable with `npm i -g earshot`, tested
on Windows Terminal in CI rather than hoped for. Most terminal agents are either
macOS-first or need a bespoke runtime. *(Planned — see [roadmap](docs/roadmap.md).)*

### 3. It listens

This is the part that isn't a feature list, and it's why the project exists. An
agent that quietly rewrites files you didn't mention, guesses instead of asking,
forgets a preference you stated twice, and reports success on work it never
verified is worse than no agent. earshot treats these as bugs with tests, not as
polish:

- **Asks before guessing** when two readings of your request lead to different work.
- **States its scope** before the first edit, and asks before going outside it.
- **Steerable mid-task** — type while it works; no need to interrupt and re-explain.
- **Remembers your preferences**, with provenance, and says which rule it applied.
- **Honest completion** — it tells you what it skipped, what it didn't verify, and
  what's still failing, instead of declaring done.

See [Listening](docs/listening.md) for how each of these is specified and tested.

## Quick start

> Requires **Node ≥ 22** (or Bun ≥ 1.3). Not yet published to npm — see
> [Installing from source](docs/getting-started.md#from-source).

```bash
git clone https://github.com/rishabhguptajs/earshot
cd earshot && bun install && bun run build
```

Point it at a provider by setting that provider's key:

```bash
export ANTHROPIC_API_KEY=sk-...
```

Then:

```bash
node packages/cli/bin/earshot.js models              # every model, with pricing
node packages/cli/bin/earshot.js models claude-opus  # filter
node packages/cli/bin/earshot.js -p "explain the provider registry"
```

Full walkthrough: [Getting started](docs/getting-started.md).

## Status

earshot is built in milestones. Honest state of each:

| Milestone | What it covers | Status |
|---|---|---|
| **M0** Scaffold | Monorepo, CI on mac/linux/windows, build | ✅ Done |
| **M1** Provider layer | Registry, catalog, auth, 7 wire adapters, headless turn | ✅ Done |
| **M2** Coding agent | Tools, permissions, sessions, Ink TUI | ✅ Done |
| **M3** Listening | Scope contract, compaction, memory | ⬜ Next |
| **M4** Extensibility | Skills, commands, hooks, MCP, subagents | ⬜ Planned |
| **M5** Ship | Docs site, npm, binaries, Windows QA | ⬜ Planned |

**Works today:** the interactive TUI and `earshot -p`, both running the full
agent loop with twelve tools; the permission system (five modes, `Tool(pattern)`
rules, deny-first); sessions with `--resume` and `--continue`; `AGENTS.md`
loading; undo snapshots; 896 models with live pricing; credential resolution
across CLI flag, env var, auth file and ambient cloud credentials; cost
accounting including prompt caching.

**Does not exist yet:** auto-compaction, the memory system, MCP, skills, hooks,
subagents, `/fork`, `/rewind` and `/undo` commands.

**Windows needs Git Bash.** `bash` uses Git for Windows and fails with an install
pointer if it is missing, rather than falling back to PowerShell. One shell
dialect on every platform keeps commands and permission rules portable.

**Not verified against live APIs.** The 185 tests run against scripted provider
output — including the whole agent loop. The bridge every adapter shares is well
covered; individual vendors are not. If you have a key for a provider and hit a
bug, [that's a very useful issue](https://github.com/rishabhguptajs/earshot/issues/new).

## How it fits together

```
  your terminal
       │
   ┌───▼────┐   Ink, inline scrollback              packages/tui
   │  TUI   │
   └───┬────┘
       │
   ┌───▼────┐   agent loop, tools, permissions,     packages/core
   │  core  │   sessions, memory, context shapers
   └───┬────┘
       │        unified messages + stream events
   ┌───▼─────────┐   registry, catalog, auth,       packages/providers
   │  providers  │   7 wire adapters
   └───┬─────────┘
       │
  19 providers / 896 models
```

Everything above the wire adapters speaks one set of types. Provider quirks that
must survive a round trip — OpenAI's encrypted reasoning, Gemini's thought
signatures — ride along opaquely and are persisted verbatim, so switching models
mid-session doesn't corrupt history. See [Architecture](docs/architecture.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, authenticate, first run |
| [CLI reference](docs/cli.md) | Every command, flag and exit code |
| [Providers](docs/providers.md) | All 19, how auth resolves, model catalog |
| [Adding a provider](docs/adding-a-provider.md) | The one-line path, and the harder one |
| [Architecture](docs/architecture.md) | Packages, the unified types, the bridge |
| [Listening](docs/listening.md) | The behaviours that make this project worth building |
| [Roadmap](docs/roadmap.md) | Milestones, what's in and out of v1 |
| [Contributing](CONTRIBUTING.md) | Dev setup, conventions, how to land a change |

## Contributing

Early contributions are especially valuable right now, because the interfaces are
still cheap to change. The highest-leverage things:

- **Try a provider you have a key for** and report what breaks. Nothing has been
  tested live.
- **Add a provider** — [one line for most vendors](docs/adding-a-provider.md).
- **M3 is open** — context shapers, auto-compaction, the memory system. See the
  [roadmap](docs/roadmap.md).
- **Use it and tell us where it stopped listening** — scope creep, a prompt that
  should not have appeared, a question it should have asked.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Be decent: [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE).
