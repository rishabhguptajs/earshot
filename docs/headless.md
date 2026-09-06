# Headless output

`earshot -p "<prompt>"` runs one non-interactive turn. With `--output-format
json` or `stream-json` it is an API, and it is versioned as one.

```bash
earshot -p "what does the registry do" --output-format json
earshot -p "fix the failing test" --output-format stream-json --permission-mode auto
```

## The version

Every object earshot writes in a JSON format carries a `schema` field:

```json
{ "schema": "earshot.v1", "type": "result", "...": "..." }
```

`earshot.v1` is a promise about change, not a version of earshot:

- **Additive changes are allowed within v1.** New record types and new fields
  may appear in any release. A consumer must ignore records whose `type` it
  does not recognise and fields it did not expect. That rule is what lets
  earshot report new things — a hook firing, a subagent finishing — without
  breaking a script already parsing the stream.
- **Renaming a field, removing one, or changing what one means requires v2.**
- **v2 will not arrive by upgrading.** It will be requested explicitly, as
  `--output-format json@v2`, and v1 will keep working alongside it. You can pin
  today: `--output-format json@v1` is accepted and means exactly what `json`
  means, so a script can state which contract it was written against.
- An output format earshot does not implement is an error and exit code 2, not
  a silent fall back to prose.

earshot's internal event type is deliberately not what gets written. It is ours
to rename; the stream is not.

The full promise, alongside ACP's and a list of the surfaces that carry no
promise yet, is in [Compatibility](compatibility.md).

## `--output-format json`

One object on stdout when the turn ends.

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | `earshot.v1` |
| `type` | string | Always `result` |
| `subtype` | string | `success`, `error`, `interrupted`, `max_steps`, `budget` |
| `isError` | boolean | True unless `subtype` is `success` |
| `text` | string | The assistant's response text for the turn |
| `costUsd` | number | Session spend, including any subagents |
| `durationMs` | number | Wall clock for the run |
| `numMessages` | number | Messages in history when the turn ended |
| `model` | string | The model reference that was requested |
| `permissionMode` | string | The mode the turn ran under |
| `sessionId` | string? | Absent when the session was not persisted |
| `error` | object? | `{ kind, message }` when `subtype` is `error` |

## `--output-format stream-json`

Newline-delimited JSON, one object per line, as things happen. The final line is
the same `result` object `--output-format json` produces — so a consumer that
reads only the last line and one that parses a single object are reading the same
thing.

| `type` | Fields |
|---|---|
| `model_start` | `model` |
| `text` | `text` (a delta, not the whole response) |
| `reasoning` | `text` |
| `intent` | `calls`, `text?` — the one-line "why" before a batch; `text` absent means none was given |
| `tool_use` | `toolCallId`, `toolName`, `input` |
| `tool_result` | `toolCallId`, `toolName`, `isError`, `output` |
| `permission` | `tool`, `target`, `title`, `reason` |
| `usage` | `usage`, `costUsd` |
| `budget` | `spentUsd`, `limitUsd`, `raisedTo?` — `raisedTo` absent means the run stopped rather than being given a higher limit |
| `compacted` | `replaced` |
| `scope` | `kind`, `summary`, `accepted` |
| `verification` | `command`, `exitCode`, `output` |
| `hook` | `event`, `blocked?`, `problems` |
| `subagent` | `description`, `steps`, `costUsd` |
| `error` | `kind`, `message`, `retryable` |
| `result` | as above |

`permission` carries the reason a call needed approval, not the diff. The full
detail of a change is for a person looking at a terminal, and a headless run has
nobody to show it to — if it needed approving, it did not run.

## Permissions in a headless run

`-p` defaults to `ask` like everywhere else. With no terminal to prompt at, a
call that needs approval is refused with an explanation the model can act on,
and the run continues. That is deliberate: the alternative is a mode where
piping a prompt into earshot silently grants it more than typing the same prompt
would.

Scripted use passes `--permission-mode` explicitly. Deny rules still apply in
every mode.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The turn finished |
| `1` | The turn failed, or hit the step limit |
| `2` | Bad usage — unknown model, unknown output format, bad permission mode |
| `3` | No credentials for the provider |
| `4` | No shell available (Git Bash missing on Windows) |
| `130` | Interrupted |
