# CLI reference

> Commands marked **planned** are in the help text but not implemented. Running
> one prints `not implemented yet` and exits 1.

## Synopsis

```
earshot [flags]                   start the interactive TUI      (planned)
earshot -p "<prompt>" [flags]     one headless turn
earshot models [filter] [flags]   list the model catalog
earshot auth <login|list>         manage credentials             (planned)
earshot mcp <list|add>            manage MCP servers             (planned)
earshot config <get|set>          read and write config          (planned)
earshot acp                       run as an ACP server           (planned)
earshot doctor                    diagnose the local setup       (planned)
```

## Global flags

| Flag | Description |
|---|---|
| `--version`, `-v` | Print the version and exit |
| `--help`, `-h` | Print help and exit |
| `--model <ref>` | Model for this run, as `provider/model` or a bare model id |

## `earshot -p`

Runs a single non-interactive turn and prints the response.

```bash
earshot -p "explain the provider registry"
earshot -p "hello" --model openrouter/anthropic/claude-opus-5
earshot -p "hello" --output-format json
```

| Flag | Values | Default |
|---|---|---|
| `--model <ref>` | any `earshot models` reference | `anthropic/claude-opus-5` |
| `--output-format <fmt>` | `text`, `json`, `stream-json` | `text` |

**Output formats**

- `text` — response text streamed to stdout as it arrives
- `json` — one `result` object at the end
- `stream-json` — newline-delimited records as they arrive, ending with the same
  `result` object

Both JSON formats are a versioned contract; see [Headless output](headless.md)
for the schema and what `earshot.v1` promises. `json@v1` pins it explicitly.

`Ctrl-C` aborts the request; partial output is kept.

## `earshot models`

Lists the model catalog with context windows, pricing and capabilities.

```bash
earshot models              # everything
earshot models opus         # filter by id, provider or name
earshot models --json       # machine-readable
earshot models --refresh    # fetch live from models.dev first
```

| Flag | Description |
|---|---|
| `--json` | Emit the full `Model` objects instead of a table |
| `--refresh` | Fetch a fresh catalog from models.dev rather than the snapshot |

Output columns: model reference, context window, price (USD per million tokens,
input/output), and capability tags (`reasoning`, `vision`, `no-tools`).

Filtering is a case-insensitive substring match against the model id, the
provider id and the display name.

## Model references

`provider/model` is unambiguous and always works:

```bash
--model anthropic/claude-opus-5
--model openrouter/anthropic/claude-opus-5
```

A bare model id resolves against the first provider offering it, in registration
order — convenient, but pin the provider in scripts, since the same model is often
served by several.

## In-session commands

Typed at the prompt during an interactive session.

| Command | Effect |
|---|---|
| `/mode <plan\|ask\|accept-edits\|auto\|yolo>` | Change the permission mode |
| `/memory` | List remembered preferences, each with the sentence it came from |
| `/memory forget <id>` | Delete one |
| `/tree` | List this session's prompts, numbered |
| `/rewind <n>` | Go back to the state before prompt `n`; nothing is deleted |
| `/fork <n>` | Branch from prompt `n` into a new transcript |
| `/undo` | Revert the last tool batch's file changes; again to step back further |
| `/exit` | Quit |

Two keystrokes are bound rather than typed: when a prompt contains a correction
("use bun, not npm"), `ctrl+r` remembers it for this project and `ctrl+g`
everywhere. Nothing is remembered unless you press one.

## Exit codes

Meaningful, so CI can branch on them:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Request failed — provider error, network, aborted |
| `2` | Unknown model reference |
| `3` | No credentials for the provider |

## Environment variables

| Variable | Effect |
|---|---|
| `EARSHOT_CONFIG_DIR` | Override the config directory (default `~/.config/earshot`, `%APPDATA%\earshot` on Windows) |
| `EARSHOT_DATA_DIR` | Override the data directory (sessions) |
| `OLLAMA_HOST` | Ollama base URL (default `http://127.0.0.1:11434`) |
| *provider keys* | See [Providers](providers.md) |
