# CLI reference

## Synopsis

```
earshot [flags]                   start the interactive TUI
earshot sessions                  browse chats saved for this directory
earshot -p "<prompt>" [flags]     one headless turn
earshot models [filter] [flags]   list the model catalog
earshot auth <login|list|logout>  manage credentials
earshot pool <setup|status|...>   pool free providers into one model
earshot mcp <list|trust|untrust>  manage MCP servers
earshot extensions <list|trust|untrust>  manage in-process extensions
earshot acp [flags]               serve editor clients over ACP v1 on stdio
earshot doctor                    diagnose the local setup
earshot update [--check]          update earshot to the latest release
earshot telemetry <enable|disable|status|reset>  manage anonymous telemetry
```

## Global flags

| Flag | Description |
|---|---|
| `--version`, `-v` | Print the version and exit |
| `--help`, `-h` | Print help and exit |
| `--model <ref>` | Model for this run, as `provider/model` or a bare model id |
| `--reasoning-effort <level>` | `auto`, `none`, `low`, `medium`, `high`, or `xhigh` |
| `--continue` | Resume the latest chat in this directory |
| `--resume <path>` | Resume an exact JSONL transcript |
| `--no-onboarding` | Skip first-run onboarding; missing credentials exit 3 like before |

## `earshot -p`

Plain `earshot` creates a new chat. `earshot sessions` or `/sessions` opens a searchable list
for the current directory; `--continue` resumes the latest. In the TUI,
`/model` and `/reasoning` open pickers, while arguments provide a fast path.
Choosing a model ends by asking where to keep it — everywhere, or this project
only — and the confirmation names the settings file it wrote.

`/reasoning on` and `/reasoning off` force reasoning for the current model
regardless of what the catalog claims it supports, which is the way out when a
provider rejects a reasoning parameter it is listed as accepting, or accepts one
it is not. The other values set the effort. `/thinking hide` hides streamed
reasoning and `/thinking show` restores it - it controls the display, not the
request.

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
| `--image <path-or-url>` | PNG, JPEG, GIF or WebP path, or HTTPS URL | none |
| `--max-cost <usd>` | session ceiling, e.g. `2.50` or `$2.50`; `0` removes one | none |
| `--curiosity <level>` | `low`, `normal`, `high` | `normal` |

**Output formats**

- `text` — response text streamed to stdout as it arrives
- `json` — one `result` object at the end
- `stream-json` — newline-delimited records as they arrive, ending with the same
  `result` object

Both JSON formats are a versioned contract; see [Headless output](headless.md)
for the schema and what `earshot.v1` promises. `json@v1` pins it explicitly.

`Ctrl-C` aborts the request; partial output is kept.

`--max-cost` is checked before each model call, not after the spend. Headless
has no one to ask, so reaching the ceiling stops the turn and exits **3** —
distinct from `1` so a script can tell "ran out of budget" from "failed".
Interactive prompts to stop, double the ceiling, or remove it. Both read
`maxCostUsd` from settings when the flag is absent.

`--curiosity` moves how readily the agent stops to ask: `low` decides and states
the assumption, `high` asks whenever a second reading is plausible. It never
turns asking off and never makes it free — see
[Listening](listening.md#1-ask-before-guessing).

`--image` attaches one image to the prompt. Local files are capped at 20 MB and
encoded into the append-only transcript; HTTPS URLs stay references for the
provider adapter. A model without the `vision` capability is rejected before a
request is made. The same flag attaches to an initial interactive TUI prompt.

## `earshot auth`

```bash
earshot auth list                              # where each provider's credentials come from
earshot auth login openrouter                  # PKCE sign-in in a browser
earshot auth login groq --api-key gsk_...      # store a key
earshot auth logout groq                       # forget the stored one
```

`logout` removes what is in `auth.json`. An environment variable still applies
afterwards, and it says so.

## `earshot pool`

A dozen vendors give away real capacity, and any one of those free tiers is too
small to code against. Pooled they are not - so `earshot pool setup` connects
them once, and `free/best`, `free/fast` and `free/cheap` route across whatever
is connected and still has quota.

```bash
earshot pool setup                 # the wizard: pick providers, paste keys
earshot pool status                # what is connected, what is spent, when it resets
earshot pool enable                # or disable; enable also makes free/best the default
earshot pool forget groq#work      # drop one account, or a whole provider
earshot pool add-endpoint <id> <base-url> <model-id>...
```

`defaultModel` is narrowest-scope-wins, so enabling the pool rewrites any
project or local settings file that pins a concrete model - otherwise a choice
saved before the pool existed would shadow it, and the pool would be on without
ever being used. `earshot doctor` warns if it finds that state.

Free tiers meter per **account**, not per key: a second key minted inside the
same account draws down the same bucket. The wizard can hold several accounts
per provider (`groq`, `groq#account-2`), each counted separately, but only
genuinely different accounts add capacity.

Cost is not the number to watch in a pooled session, because everything in it
is free. Quota is, and `earshot pool status` is where you read it: requests used
against each account's daily and per-minute limits, when a rate-limited one
comes back, and which concrete model each `free/*` tier resolves to right now.

Published limits are estimates - vendors change them, document them poorly, and
apply them per model. earshot paces against the table, then narrows it from what
actually happens: a 429 both parks that account and lowers the ceiling it
believes in. Requests are counted locally, so a key also being used by another
tool will be undercounted, and the 429 is what corrects it.

Some free tiers are documented as using what you send to improve their models.
Those are marked `trains on your data` in the wizard and in `pool status`, since
earshot reads your source. They are not excluded - that is your call - but
`"pool": { "excludeTrainingProviders": true }` in settings leaves them out.

Two members are not just a key. **NVIDIA NIM** meters against signup credits
rather than a daily request count, so there is no honest per-day figure to show -
`pool status` reports what has been spent and lets the first 429 set the ceiling.
**Cloudflare Workers AI** meters in *neurons* (10,000 a day free), and what one
request costs depends on the model and the length of the turn; the wizard asks
for your account id as well as a token, because Workers AI puts the account in
the endpoint URL.

Local runtimes (Ollama, LM Studio) join the pool as the floor: no key, no quota,
and the only members that cannot be exhausted. They are reached once every
metered account is spent.

`add-endpoint` points earshot at any OpenAI-compatible URL. earshot ships no
unofficial or reverse-engineered providers - they break constantly and can get
your upstream account banned - so this is the door for anyone who wants one
anyway.

## `earshot mcp`

```bash
earshot mcp list             # configured servers; starts nothing
earshot mcp trust helper     # let a project-scope server start
earshot mcp untrust helper
```

See [Extending earshot](extending.md#mcp-servers) for why a project-scope server
needs trusting and a global one does not.

Past 25 MCP tools, their schemas are no longer sent with every request. The
model gets a `tool_search` tool and finds them by what it wants to do; a
surfaced tool stays listed for the rest of the session and is gated exactly as a
listed one is.

## `earshot extensions`

```bash
earshot extensions list      # modules found; imports nothing untrusted
earshot extensions trust jira
earshot extensions untrust jira
```

In-process TypeScript or JavaScript modules that contribute tools, from
`.earshot/extensions/` or the config directory. See [Extending
earshot](extending.md#in-process-extensions) — an extension is not sandboxed, so
a project one is inert until trusted.

## `earshot acp`

Runs the stable ACP v1 server used by Zed and other ACP-capable editors:

```bash
earshot acp --model anthropic/claude-opus-5
```

It is a stdio protocol command, not an interactive terminal command. The model,
API key and permission-mode flags become defaults for sessions the editor opens.
See [Editor integration with ACP](acp.md) for the supported protocol surface and
the reproducible Zed, JetBrains and Neovim QA checklists.

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

## `earshot doctor`

Runs local diagnostics without contacting a model provider or printing secrets.
It checks the earshot and Node versions, platform, Git, Bash (Git Bash on
Windows), writable config/data locations, settings JSON, and POSIX auth-file
permissions. It also checks that the configured `defaultModel` still exists —
free model listings churn on a timescale of days, and a default pointing at a
retired one fails on the first turn of every session with an error that says
nothing about where the bad reference came from. `PASS` and `WARN` checks exit
0; any `FAIL` exits 1.

## `earshot update`

Updates earshot in place, whichever way it was installed.

```bash
earshot update            # check, confirm, update
earshot update --check    # report only; exit 4 if an update is available
earshot update --yes      # skip the confirmation
```

It works out how the running earshot got here before it does anything. A
standalone binary is a Bun `--compile` executable, so its entry module lives in
Bun's `$bunfs` virtual filesystem rather than on disk — that path is the
signal. `process.versions.bun` is not, since it is equally set when running from
a source checkout under Bun, and the executable's filename is not, since it is
whatever it was renamed to.

**Installed with npm.** Compares against the npm registry and, on a global npm
install, offers to run:

```
earshot 0.2.0  ->  0.3.1   (installed with npm, globally)

  npm install -g @raegent/earshot@latest

run it now? [y/N]
```

If the package sits in a bun, pnpm, yarn or Volta tree instead, that manager's
command is printed and nothing is run — `npm install -g` over one of those does
not replace the install, it adds a second copy at another prefix and leaves PATH
order to decide which one wins. A project-local install is printed too, not run.

**Standalone binary.** Downloads the release asset matching this host, verifies
it against the `SHA256SUMS` published with every release, and only then puts it
in place. A mismatch replaces nothing.

```
earshot 0.2.0  ->  0.3.1   (standalone binary)
  /Users/you/.local/bin/earshot   earshot-darwin-arm64

download earshot-darwin-arm64 and replace it? [y/N] y
  downloading… verifying SHA256… replacing…
updated to 0.3.1
```

The download lands in the target's own directory, not the temp directory, so the
final step is a same-filesystem rename rather than a copy across devices. On
POSIX that rename is atomic and the running process keeps executing from the
inode it already opened. On Windows a running `.exe` cannot be deleted or
overwritten, but it can be renamed on the same volume, so the running image is
moved to `earshot.exe.old-<pid>` and the new one takes its place; deleting that
leftover fails while the process lives, and the next `earshot update` sweeps it.

Assets are fetched through the GitHub asset API rather than the
`releases/download/…` browser URL, because that URL ignores a bearer token and
answers 404 for a private repository. **While this repository is private, a
binary update needs a token**: set `GITHUB_TOKEN` (or `GH_TOKEN`, or
`EARSHOT_GITHUB_TOKEN`) to one that can read the repository. Without it every
release URL returns 404, and `earshot update` says so rather than repeating the
status. The npm path needs no token — that package is public.

A symlinked binary is resolved first, so the file is replaced rather than the
link. Running from a source checkout is not updatable and exits 2 — use git.
Without a TTY to answer the prompt, it reports and changes nothing.

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
| `/help` | List the commands you can type |
| `/model [ref]` | Show the model in use, or switch to another for the rest of the session |
| `/reasoning [on\|off\|auto\|none\|low\|medium\|high\|xhigh]` | Change reasoning effort, or force reasoning on or off for this model |
| `/thinking [show\|hide]` | Show or hide streamed model reasoning |
| `/pool [setup\|on\|off]` | Show free-provider quota, or connect more providers |
| `/telemetry [enable\|disable\|status\|reset]` | Manage opt-in anonymous telemetry |
| `/mode <plan\|ask\|accept-edits\|auto\|yolo>` | Change the permission mode |
| `/plan <task>` | Draft a plan in plan mode and write it to a file |
| `/plan edit` | Open the plan in `$VISUAL`/`$EDITOR`, or print its path |
| `/plan approve` | Pin the plan **as the file now reads** for the rest of the run |
| `/plan show` | Read the plan back |
| `/plan clear` | Unpin the plan |
| `/compact` | Summarise the session so far and free up the context window |
| `/context` | Show what is in the context window and what compaction has dropped |
| `/cost [usd]` | Show what this session has spent, or set the budget ceiling; 0 removes it |
| `/todo` | Show the agent's current todo list |
| `/permissions` | Show the permission mode and the rules in force |
| `/init` | Write an `AGENTS.md` describing this project |
| `/skills` | List discovered skills and user-defined commands |
| `/memory` | List remembered preferences, each with the sentence it came from |
| `/memory forget <id>` | Delete one remembered preference |
| `/tree` | List this session's prompts, numbered |
| `/sessions` | Browse and resume chats saved for this project |
| `/rewind <n>` | Go back to the state before prompt `n`; nothing is deleted |
| `/fork <n>` | Branch from prompt `n` into a new transcript |
| `/undo` | Revert the last tool batch's file changes; again to step back further |
| `/exit` | Quit |
| `/<name>` | Run a user-defined command from `.earshot/commands/<name>.md` |

This table is checked against the command registry in
`packages/tui/src/commands.ts` by `packages/tui/test/commands.test.ts`, which is
also what the in-session `/` menu reads: a command cannot be documented without
being dispatchable, or dispatchable without appearing in both.

`/model` switches for the rest of the session, resolving the reference through
the same registry and credential order the CLI uses; a reference with no
credentials is reported and the session stays on the model it had.

`/cost` with an amount is the same ceiling as `--max-cost`, and `0` removes it
the same way. `/compact` runs the compaction that would otherwise happen at 80%
of the window — it appends a summary and never rewrites history, exactly as the
automatic one does.

Typing `/` opens that menu and each further keystroke filters it. `↑`/`↓` move
the selection, `tab` completes the highlighted command into the line without
running it, `enter` runs it, and `esc` closes the menu — `esc` interrupts a turn
only when the menu is not open.

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
| `4` | `earshot update --check` only: an update is available |

## Environment variables

| Variable | Effect |
|---|---|
| `EARSHOT_CONFIG_DIR` | Override the config directory (default `~/.config/earshot`, `%APPDATA%\earshot` on Windows) |
| `EARSHOT_DATA_DIR` | Override the data directory (sessions) |
| `EARSHOT_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` | Read access for `earshot update`'s binary path, in that order of preference. Required while the repository is private |
| `OLLAMA_HOST` | Ollama base URL (default `http://127.0.0.1:11434`) |
| *provider keys* | See [Providers](providers.md) |
