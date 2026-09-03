# Architecture

How earshot is put together, and why. Sections marked **planned** describe design
that isn't built yet — see [status](../README.md#status).

## Packages

A Bun workspace monorepo. One package publishes (`earshot`); the rest are internal
and bundled into it at build time.

| Package | Responsibility |
|---|---|
| `packages/providers` | `Provider`/`WireApi` interfaces, registry, model catalog, auth store, wire adapters |
| `packages/core` | Agent loop, tools, permissions, sessions, undo; context shapers *(planned)* |
| `packages/mcp` | MCP client manager *(planned)* |
| `packages/tui` | Ink app, inline scrollback |
| `packages/cli` | The `earshot` binary; the only publishable package |

Dependencies point one way: `cli → tui → core → providers`. Nothing in
`providers` knows the agent loop exists.

## The unified types

The central design decision. Everything above the wire adapters — the agent loop,
the TUI, sessions, subagents — speaks one set of types, defined in
[`packages/providers/src/types.ts`](../packages/providers/src/types.ts):

```
Message      role + MessagePart[]
MessagePart  text | reasoning | image | tool_call | tool_result
ModelRequest system, messages, tools, toolChoice, reasoningEffort, abortSignal
StreamEvent  text_delta | reasoning_delta | tool_call_start/delta/end
             | usage | finish | error
```

A wire adapter is the only component that translates these to a vendor's actual
API. That's what makes provider-agnostic behaviour real rather than aspirational:
switching from Anthropic to Gemini mid-session doesn't change a single type the
loop sees.

### providerMetadata

Some vendor data must survive a round trip or the *next* request fails:

- OpenAI requires reasoning to be replayed as encrypted content
- Gemini 3 requires `thought_signature` on function-call parts
- Anthropic enforces append-only history for thinking blocks

Rather than model each quirk in the unified types, every part carries an opaque
`providerMetadata` bag, namespaced by provider. The loop never reads it; the
adapter that produced it is the only thing that understands it; and it is
persisted verbatim in the session transcript so replay is lossless.

`ProviderMetadata` is JSON-valued by construction. That's enforced by the type
system deliberately: it round-trips through JSONL, so anything unserialisable
would corrupt replay silently rather than failing loudly.

## The AI SDK bridge

The single most leveraged file in the project:
[`packages/providers/src/wire/ai-sdk.ts`](../packages/providers/src/wire/ai-sdk.ts).

Rather than hand-write an HTTP client per vendor, earshot bridges its unified
types to the [Vercel AI SDK](https://ai-sdk.dev)'s `LanguageModelV4` spec **once**.
Every AI SDK provider package then becomes an earshot wire adapter in about two
lines:

```ts
export const anthropicWire = createAiSdkWire('anthropic-messages', (modelId, ctx) =>
  createAnthropic({ apiKey: key(ctx), ...common(ctx) })(modelId),
);
```

Consequences worth being explicit about:

- **Upside.** 7 adapters and 19 providers for roughly 400 lines. AWS SigV4 and
  Google ADC come free. New AI SDK providers are near-zero cost to adopt.
- **Cost.** earshot inherits the AI SDK's spec and its bugs, and a spec bump
  (`V4` → `V5`) means updating the bridge.
- **Boundary.** earshot uses AI SDK **provider packages only** — the wire layer.
  It does not use the SDK's agent, tool-calling, or streaming helpers. The loop is
  ours, because the loop is the product.

The bridge handles the awkward parts: tool inputs arrive as JSON strings and are
parsed to values; nested usage is flattened; empty content runs are dropped
because Anthropic rejects them; and a stream that closes without a terminal
`finish` still produces exactly one `finish` event, because the loop depends on it.

## Provider quirks

Where each known quirk is handled:

| Quirk | Handling |
|---|---|
| OpenAI encrypted reasoning | `providerMetadata` on reasoning parts, replayed as `providerOptions` |
| Gemini `thought_signature` | Same mechanism; captured on `reasoning-end` |
| Anthropic append-only history | Transcript is append-only by construction; compaction writes a new entry |
| Anthropic refusal | `finish.reason` keeps the vendor's raw value, so refusal isn't flattened into `stop` |
| Context overflow | Detected from the message behind a generic 400 and typed as `context_overflow` |
| Ollama drops streamed tool calls | Provider carries a `notice`; native adapter planned |

## Error taxonomy

Adapters map vendor failures onto one taxonomy so the loop can decide what to do
without knowing the provider: `auth`, `rate_limit`, `context_overflow`,
`invalid_request`, `server`, `network`, `abort`, `unknown` — each with a
`retryable` flag. Context overflow is the interesting one: no provider gives it a
distinct status code, so it's recovered from a 400's message and becomes the
trigger for compaction rather than a hard failure.

## Model catalog

Model metadata comes from [models.dev](https://models.dev) rather than a
hand-maintained list. At build time,
[`scripts/fetch-catalog.ts`](../scripts/fetch-catalog.ts) prunes its 4.4 MB / 212
providers to ~380 kB: supported providers only, the fields the harness reads only,
and text-output chat models only.

`ModelCatalog` merges three layers: the vendored snapshot, an optional live
refresh, and user overrides from config. A model the registry has never heard of
is a config entry, not a release.

## Agent loop

Single-threaded, flat, append-only message list — the same shape Claude Code uses,
and what Anthropic's preserved-thinking requires:

```
assemble context → stream model → collect tool calls → permission gate
  → execute (read-only in parallel, mutating serialised) → append results → repeat
```

`runTurn()` in [`agent.ts`](../packages/core/src/agent.ts) is an async generator
yielding events, so the TUI and the headless renderer are two consumers of one
loop rather than two loops.

Three properties the implementation holds to:

- **Every tool call gets a result part**, including calls interrupted before they
  ran and calls naming a tool that does not exist. A provider rejects the next
  request when an assistant tool call has no matching result, so "interrupted"
  has to be a result rather than a gap.
- **Results are ordered by emission, not completion.** Read-only calls run
  concurrently, but a replayed transcript is deterministic.
- **A failing tool is data, not a crash.** Bad input, a denied permission, a
  non-zero exit — all come back as error results the model reads and reacts to.
  Only the model call itself failing ends a turn early.

Interruptible via `AbortSignal`. Messages typed mid-turn are queued and injected
between one model call and the next — never mid-batch, which would contradict a
tool call the model is still awaiting a result for.

## Tools

Twelve, in [`packages/core/src/tools`](../packages/core/src/tools). Two rules
shape the rest:

`defineTool` refuses to construct a mutating tool with no `permission()`. The
gate sees only a tool's `PermissionRequest`, so without this a new tool could
skip the gate by forgetting to describe itself — silently, and looking like it
worked.

`edit` refuses a `find` string matching more than once rather than taking the
first occurrence, and requires the file to have been read this session. The model
cannot see which occurrence it hit; picking one is how an edit lands in the wrong
function.

`bash` uses Git Bash on Windows and fails with an install pointer when it is
absent. See [the roadmap](roadmap.md#m2--coding-agent-) for why not PowerShell.

## Permissions

Modes `plan | ask | accept-edits | auto | yolo`, over `Tool(pattern)` rules
loaded from global, project and local settings. `decide()` is pure — rules and a
request in, a decision out — so the policy is tested without a terminal.

Order is the policy, and it is deliberately not "most specific wins":

1. A matching **deny** rule refuses. No mode and no allow rule overrides it.
2. Read-only tools never prompt.
3. `plan` refuses every mutating tool.
4. A **write outside cwd** prompts whatever the rules say, in every mode but yolo.
5. `yolo` allows.
6. A matching **ask** rule prompts even where an allow rule would match.
7. A matching **allow** rule allows.
8. Otherwise the mode decides.

Rules from the three scopes are concatenated rather than shadowing one another: a
scoped override would let a project's checked-in settings remove a deny rule the
user set globally.

Command patterns match **every segment** of a chained command. Without that,
`Bash(npm run *)` would allow `npm run build && rm -rf ~`.

## Undo

Per-tool-batch snapshots in a git object database under the data dir, with
`GIT_DIR` pointed away from the project. The user's repository is never touched —
no commits, no stash, no index changes. An agent that commits to manage its own
undo has silently rewritten the user's history.

Per batch rather than per call, so undo restores a coherent unit. git being
absent disables undo rather than failing.

## TUI

Completed turns go into Ink's `Static`; only the live region re-renders. That is
what makes the scrollback real — the user's terminal owns scrolling and
selection, and a long session does not repaint thousands of rows per token.

Two Windows constraints are held by construction: nothing writes a DA1 or DCS
terminal query (ConPTY neither answers nor rejects them, so a probe reads as a
60-second hang at startup), and the frame rate is capped at 30 there.

## Sessions

JSONL under `~/.local/share/earshot/sessions/<cwd-hash>/<id>.jsonl`, tree
structured (`id`, `parentId`) so `/fork`, `/rewind`, `--resume` and `--continue`
are all navigation over one file. Append-only: compaction and rewind add entries
rather than rewriting history. Permissions are deliberately **not** restored on
resume.

Two details that are easy to get wrong and were: an append reads its parent
inside the write queue, not at call time — reading it eagerly makes concurrent
appends siblings of one entry rather than a chain — and session ids carry a
time-ordered prefix, because UUIDs do not sort by creation and mtimes tie within
a millisecond, which left `--continue` picking arbitrarily.

## Context shapers *(planned — M3)*

Run in order before each call, cheapest first: cap individual tool results, prune
old tool results to one-line stubs, then auto-compact at ~80% of the model's
window — a model-written summary plus the last K turns verbatim, open todos, and
files touched.

## Design rules

Constraints a change should respect:

1. **Adding a provider touches one file.** If it needs more, the abstraction is wrong.
2. **The wire layer is the only thing that speaks HTTP.**
3. **History is append-only.** Anthropic enforces it; every other feature is designed as if all providers do.
4. **Provider-specific data stays opaque above the adapter.**
5. **The loop is ours.** Wire protocols are a commodity; agent behaviour is the product.
