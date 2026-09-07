# Getting started

> earshot is pre-1.0. The agent loop, terminal UI, permissions, sessions,
> extensions, npm package and standalone binaries are built and tested. See
> [status on GitHub](https://github.com/rishabhguptajs/earshot#status) for the remaining live QA.

## Requirements

- **Node ≥ 22**, or **Bun ≥ 1.3**. Node 22 is the floor because earshot targets
  `npm i -g` and relies on modern ESM plus import attributes.
- **Bun** is required for development (workspaces, test runner, bundler). It is
  not required to *run* earshot.

## Install

### From npm

```bash
npm install --global @raegent/earshot
earshot doctor
```

The npm package requires Node 22 or newer. It does not require Bun.

### Standalone binary

Release assets are named for their platform:

| Platform | Asset |
|---|---|
| macOS Apple silicon | `earshot-darwin-arm64` |
| macOS Intel | `earshot-darwin-x64` |
| Linux x64 | `earshot-linux-x64` |
| Linux arm64 | `earshot-linux-arm64` |
| Windows x64 | `earshot-windows-x64.exe` |

Download the matching asset from GitHub Releases, make it executable on macOS
or Linux (`chmod +x earshot-*`), and put it somewhere on `PATH`. The standalone
build embeds Bun and does not require Node or Bun to be installed.

### Updating

```bash
earshot update
```

One command for both install forms: it detects whether it is running as an npm
install or a standalone binary and updates that one. A binary update is verified
against the `SHA256SUMS` published with the release before anything is replaced.
Nothing happens without a confirmation — `--yes` skips it, `--check` reports and
exits **4** if an update is available. See
[`earshot update`](cli.md#earshot-update).

While this repository is private, updating a **standalone binary** needs a
GitHub token that can read it — `GITHUB_TOKEN`, `GH_TOKEN` or
`EARSHOT_GITHUB_TOKEN`. Updating an npm install does not; that package is
public.

A source checkout updates with git, not this command.

### From source

```bash
git clone https://github.com/rishabhguptajs/earshot
cd earshot
bun install
bun run build
```

That produces `packages/cli/dist/main.js`, run through the `earshot` bin:

```bash
node packages/cli/bin/earshot.js --version
```

To get a global `earshot` command on your PATH while developing:

```bash
cd packages/cli && npm link
```

## Authenticate

Skip this section on a first run in a real terminal: starting `earshot` with no
credentials configured opens the TUI into onboarding — pick a provider, search
and select one of its model IDs, then sign in or paste a key. That model becomes
your global default, so later starts go directly to a fresh chat. Nothing is printed or logged: the key goes straight into the same
`auth.json` `earshot auth login` writes to, `0600` and atomic. `--no-onboarding`
restores the old dead end for scripts and CI, and `earshot -p` and `earshot acp`
never onboard — a script has nobody to answer a prompt, so a missing credential
there still exits 3 immediately, same as always.

To set up credentials ahead of time instead, or for a provider onboarding does
not ask about first:

earshot resolves credentials in a fixed order, first match wins:

1. A CLI flag (`--api-key`)
2. The provider's environment variable
3. `~/.config/earshot/auth.json` (mode `0600` on POSIX)
4. Provider-native ambient credentials — the AWS credential chain, Google ADC

For most providers, setting one environment variable is all you need:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...
export OPENROUTER_API_KEY=sk-or-...
```

Every provider and its variables: [Providers](providers.md).

Bedrock and Vertex use ambient credentials — if `aws` or `gcloud` already works
on your machine, earshot works too. No key to set.

Local runtimes need no credentials at all:

```bash
ollama serve   # earshot discovers whatever you have pulled
```

## First run

List what you can reach:

```bash
earshot models
```

```
anthropic/claude-opus-5              1000k       $5/$25  reasoning vision
anthropic/claude-sonnet-5            1000k       $2/$10  reasoning vision
openai/gpt-5.2                        400k    $1.75/$14  reasoning vision
google/gemini-flash-lite-latest      1049k    $0.3/$2.5  reasoning vision
...
896 models across 18 providers (catalog 2026-09-03)
prices are USD per million tokens, input/output
```

Filter by provider, model id or name:

```bash
earshot models opus
earshot models groq
```

Run a single turn:

```bash
earshot -p "explain what a wire adapter is in this codebase"
```

Pick a model explicitly — the default is `anthropic/claude-opus-5`:

```bash
earshot -p "hello" --model openrouter/anthropic/claude-opus-5
earshot -p "hello" --model ollama/qwen3-coder
```

Inside the TUI, `/model` opens the searchable model picker and `/reasoning`
changes effort. Earshot remembers these choices per project. Plain `earshot`
starts a new chat; `earshot sessions` browses saved chats and `earshot
--continue` resumes the latest one.

Get structured output instead of prose:

```bash
earshot -p "hello" --output-format json
```

```json
{
  "text": "Hello.",
  "model": "anthropic/claude-opus-5",
  "usage": { "inputTokens": 9, "outputTokens": 3 },
  "costUsd": 0.00012
}
```

`-p` uses the same agent loop and tools as the interactive UI. Permission
requests cannot be answered interactively in headless mode, so select an
appropriate permission mode or configure explicit rules for automation.

## Troubleshooting

Start with:

```bash
earshot doctor
```

It checks the runtime, Git, the shell used for tools, writable state directories,
settings JSON, and auth-file permissions without printing credentials.

**`no credentials for Anthropic: set ANTHROPIC_API_KEY, or run earshot auth login anthropic`**
Exit code 3. The named environment variable isn't set. (`earshot auth login`
isn't implemented yet — set the variable.)

**`unknown model "foo/bar"`**
Exit code 2. Run `earshot models` to see valid references. A reference is
`provider/model`; a bare model id works when it's unambiguous.

**`AWS region setting is missing`**
Bedrock reached the AWS SDK, which means credentials resolved fine — you just
need `AWS_REGION` set.

**A provider misbehaves in a way not listed here**
Likely a real bug. Please
[open an issue](https://github.com/rishabhguptajs/earshot/issues/new) with the
provider, model and full error.

## Next

- [CLI reference](cli.md) — every flag and exit code
- [Providers](providers.md) — all 19
- [Architecture](architecture.md) — how the pieces fit
