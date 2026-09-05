# Extending earshot

Five ways to add behaviour: MCP servers, in-process extensions, skills, slash
commands and hooks. All five are content that ends up in front of a model or a
shell, and all five are designed on the assumption that the other side is
hostile or broken.

The rule they share: **nothing here can grant a permission.** A skill, a hook and
an MCP server can each tell earshot to do something, and each of those things
goes through the same gate a request typed by the user does. What they cannot do
is approve it.

The ACP server is another consumer of these boundaries, not a bypass around
them. An editor can display and answer a permission request, but cannot turn a
deny into an allow. MCP servers configured for an ACP session are still loaded
through earshot's trust and permission rules; client-provided MCP process
definitions are currently rejected.

## MCP servers

Configured under `mcpServers` in settings, in the shape Claude Code uses:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

stdio and streamable HTTP. The pre-2025 `sse` transport is not supported and is
reported rather than ignored.

**Tools are namespaced** `server__tool`, so two servers cannot collide, and a
server name may not itself contain `__` — one that could would be able to
impersonate another server's tools.

**Past 25 MCP tools, they are not listed in the prompt.** Instead the model gets
one `tool_search` tool and finds them by what it wants to do. A search surfaces
at most ten at a time and they stay listed for the rest of the session. Nothing
about the gate changes: a surfaced tool is permission-checked exactly as it would
have been had it been listed all along, and `tool_search` itself grants nothing.

**An MCP tool is never read-only.** A server's `readOnlyHint` is an assertion by
the same party that wrote the tool, so earshot displays it and does not believe
it: every MCP call is serialised and gated. Rules name one tool, not one server:

```json
{ "permissions": { "allow": ["Mcp(github__search_issues)"], "deny": ["Mcp(github__create_*)"] } }
```

**A server the project checked in does not start on its own.** A stdio server
named in `.earshot/settings.json` is code the repository chose, and starting the
process it names is running that code. It is listed with an explanation until
you run `earshot mcp trust <name>`, which records approval in
`.earshot/settings.local.json` — not committed, so a repository cannot trust
itself in the next clone. Servers you define globally or locally start normally.

A server that fails to start, hangs, dies mid-session or floods its output is
reported and skipped; the session runs with the tools it does have.

| Command | Effect |
|---|---|
| `earshot mcp list` | What is configured, and which servers are not started |
| `earshot mcp trust <name>` | Allow a project-scope server to start |
| `earshot mcp untrust <name>` | Withdraw that |

## In-process extensions

A TypeScript or JavaScript module that contributes tools without a process
between it and earshot. Put one in `.earshot/extensions/` for a project, or in
`extensions/` under the config directory for every project. Every `.ts`, `.mts`,
`.js` or `.mjs` file there is one extension, named after its file.

```ts
// .earshot/extensions/jira.ts
export default {
  tools: [
    {
      name: 'ticket',
      description: 'Reads a Jira ticket by key',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      readOnly: true,
      async execute(input) {
        return `ticket ${input.key}`;
      },
    },
  ],
};
```

No import is needed and none is offered: earshot ships as a bundled binary, not
as a library, so a contract that required importing it would only work where
earshot happened to be resolvable. The shape is structural and validated on
load. `execute` may return a string or `{ output, isError?, title? }`.

**An extension is not sandboxed and cannot be.** Being in-process is the whole
point of it — that is what an MCP server is for otherwise. So the boundary is
not what it may do once loaded, but whether it is loaded at all: an extension
checked into a repository you cloned stays inert until
`earshot extensions trust <name>` names it, recorded in `.earshot/settings.local.json`, which is not
committed. One under your own config directory is your own file and loads.

**Its tools are namespaced and gated.** `jira.ts` contributing `ticket` becomes
`jira__ticket`, so an extension cannot shadow `bash`. A tool that is not
`readOnly` goes through the permission gate as `Extension(jira__ticket)`; an
extension may write the title and detail the prompt shows, but not the rule name
or target, or it could match a rule you wrote for something else. Unlike an MCP
server, a `readOnly` claim here is honoured — a false one is the least of what
code you already imported into the process could do.

A module that throws on import, or that does not default-export an object, costs
that extension's tools and nothing else; `earshot extensions list` names what is
there without importing anything untrusted.

## Skills

`.earshot/skills/<name>/SKILL.md`, or `<config>/skills/<name>/SKILL.md`. A single
`<name>.md` works too.

```markdown
---
description: how we cut a release here
allowed-tools: read, grep, bash
---

Run `bun run release`, then …
```

The system prompt carries only the index — name and description. The body is
loaded when the model decides the task is one the skill covers, which is why a
skill is not just more system prompt.

**A skill is text, and text is not an action.** It can describe running a
command; it cannot run one, and it cannot approve one. `allowed-tools` is
intersected with what the session already offers, so it only ever removes tools
— and it can never remove `ask_user`, since a skill that narrowed away the
ability to ask would switch off "ask rather than guess" by writing a list. The
narrowing is cleared when the turn ends.

A skill is named after its file, never after its frontmatter, and your own skills
win a name collision with a project's. A repository adding a skill is one thing;
a repository redefining one you wrote is another.

## Slash commands

`.earshot/commands/<name>.md`, or `<config>/commands/<name>.md`.

```markdown
---
description: review a pull request
---

Review PR $1. Focus on $ARGUMENTS.
```

Typing `/name args` expands the file and runs it as an ordinary prompt.
`$ARGUMENTS` is everything after the name; `$1`–`$9` are the words. It is not a
second route to the tools: whatever the file asks for goes through the same turn
and the same gate as anything typed by hand.

`/skills` lists both skills and commands, with where each came from.

## Hooks

Claude Code's contract, so hooks you already have keep working: the same settings
shape, the same JSON on stdin, the same exit code 2 convention.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "write|edit", "hooks": [{ "type": "command", "command": "./scripts/guard.sh", "timeout": 10 }] }
    ]
  }
}
```

| Event | May |
|---|---|
| `SessionStart` | Add context to the session |
| `UserPromptSubmit` | Block the prompt, or add context to it |
| `PreToolUse` | Block a call, or turn an allow into a prompt |
| `PostToolUse` | Add context to the result |
| `Stop` | Ask for one more model call — once per turn |
| `SessionEnd` | Observe |

**A hook may never approve.** `"decision": "approve"` and
`permissionDecision: "allow"` are read, reported and ignored. A hook command
lives in a settings file — including a project's checked-in one — so a hook that
could approve would be a repository granting itself permissions you never gave.
Hooks make the answer stricter or leave it alone. This is the one deliberate
incompatibility with Claude Code.

`PostToolUse` cannot block, because the tool has already run and saying otherwise
would tell the model something untrue. Its output is appended to the result,
never substituted for it.

**Failure is not obedience.** A hook that times out is killed and blocks nothing.
One that exits non-zero for any reason other than 2 is reported and blocks
nothing. One that prints something unparseable has it treated as a note. All of
it is shown to you — a hook failing quietly is one you go on believing protects
you.

Hooks from every scope are concatenated rather than overriding one another, so a
project cannot remove one you set globally.

## Subagents

The `task` tool runs a nested agent with its own context window and returns its
answer, not its transcript — so a search across a large codebase costs the parent
one paragraph instead of forty tool results.

What it inherits:

| | |
|---|---|
| Permission mode and rules | Yes — nothing it does escapes the gate |
| The declared scope | Yes, the same contract object; a file nobody listed still prompts |
| Cost | Yes, onto the session's total. A budget a subagent could spend outside is not a budget |
| An approved plan | Yes |
| Context | **No** — that is the point |
| The session transcript | No; its messages are not yours |
| A `task` tool of its own | No; nesting stops at one level |

Its tool list is intersected with the parent's and defaults to the read-only
tools. Starting one is itself gated, so `Task(...)` rules work on it. A subagent
that ran out of steps says so rather than passing off a partial answer.
