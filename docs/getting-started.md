# Getting started

> earshot is pre-alpha. The provider layer works; the agent loop and TUI don't
> exist yet. See [status](../README.md#status).

## Requirements

- **Node ≥ 22**, or **Bun ≥ 1.3**. Node 22 is the floor because earshot targets
  `npm i -g` and relies on modern ESM plus import attributes.
- **Bun** is required for development (workspaces, test runner, bundler). It is
  not required to *run* earshot.

## Install

### From npm

Not published yet. The name is reserved for the first release; until then, build
from source.

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

earshot resolves credentials in a fixed order, first match wins:

1. A CLI flag (`--api-key`)
2. The provider's environment variable
3. `~/.config/earshot/auth.json` (mode `0600`)
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

> `-p` runs **one model call with no tools**. It cannot read or edit files yet.
> That arrives with the agent loop in M2.

## Troubleshooting

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
Likely a real bug: no provider has been tested against a live API yet. Please
[open an issue](https://github.com/rishabhguptajs/earshot/issues/new) with the
provider, model and full error.

## Next

- [CLI reference](cli.md) — every flag and exit code
- [Providers](providers.md) — all 19
- [Architecture](architecture.md) — how the pieces fit
