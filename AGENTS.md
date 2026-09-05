# earshot

A terminal coding agent that actually listens. TypeScript, ESM, Node >= 22 and Bun.

## Layout

- `packages/providers` - `Provider`/`WireApi` interfaces, registry, model catalog, auth store.
  Nothing here talks to the agent loop; everything above the wire speaks the unified
  types in `src/types.ts`.
- `packages/core` - agent loop (`agent.ts`), tools (`tools/`), permissions
  (`permissions/`), sessions (`session/`), undo (`undo/`), context (`context/`).
- `packages/mcp` - MCP client manager. Depends on `core`, never the reverse:
  tools reach a session through `createSession({ extraTools })`, so core does not
  know MCP exists.
- `packages/tui` - Ink app. Completed turns go into `Static`; only the live region
  re-renders.
- `packages/cli` - the `earshot` binary; the only publishable package.

## Commands

- `bun test` - test suite
- `bun run typecheck` - `tsc -b` across the project references
- `bun run lint` / `bun run format` - biome

## Rules that are not style preferences

- **A mutating tool must declare `permission()`.** `defineTool` throws otherwise.
  The gate never sees the tool, only its `PermissionRequest`, so a tool that
  forgets to describe itself would silently skip approval.
- **Deny beats everything.** No permission mode and no allow rule overrides a
  deny rule, at any scope. If a change makes that untrue, the change is wrong.
- **A permission prompt shows the real command or the real diff.** Never a
  summary - that is the thing that trains people to approve without reading.
- **History is append-only.** Anthropic rejects edited thinking blocks. Rewind
  and compaction append entries; they never rewrite.
- **Every tool call gets a result part**, including interrupted ones, or the next
  request fails.
- **No DA1/DCS terminal queries anywhere in the TUI.** ConPTY swallows them and
  the process hangs for 60s on Windows. Feature-flag any capability detection off
  on Windows.
- **`bash` is Git Bash on Windows, never PowerShell.** One shell dialect keeps
  commands and permission rules portable.
- **Nothing loaded from a file may grant a permission.** A skill, a hook and an
  MCP server can each say what should happen; none of them can approve it. A
  hook's `"decision": "approve"` is read, reported and ignored, `allowed-tools`
  intersects rather than unions, and an MCP tool is never `readOnly` whatever
  its `readOnlyHint` claims. Settings files travel with repositories; a feature
  that lets one of them approve is a repository granting itself rights.
- **A subagent shares the parent's `ScopeContract` object**, not a copy, and
  spends onto the parent's cost total. Either as a copy would be a way out of
  the contract the parent declared.

## Conventions

- Imports use explicit `.ts` extensions; `rewriteRelativeImportExtensions` handles emit.
- `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.
  Build optional properties conditionally (`...(x !== undefined ? { x } : {})`) rather
  than assigning `undefined`.
- Adding a provider should touch one file. If it needs more, the abstraction is wrong.
- Provider-specific data that must survive a round-trip goes in `providerMetadata`,
  opaque to everything above the adapter, and is persisted verbatim in the transcript.

## Adding a provider

Most vendors are OpenAI-compatible. Adding one is a single entry in
`packages/providers/src/catalog/supported.ts`:

```ts
{ id: 'groq', catalogId: 'groq', api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1' },
```

`catalogId` is the models.dev provider id; models, pricing, context windows and
env var names come from the pruned snapshot (`bun run scripts/fetch-catalog.ts`).
Users can add an unlisted endpoint at runtime with `customProvider()` - no code change.

A vendor with its own wire protocol needs a wire adapter too, which is a two-line
binding in `src/wire/adapters.ts` if an AI SDK provider package exists for it.
The bridge in `src/wire/ai-sdk.ts` is shared by every adapter, so
`packages/providers/test/conformance.test.ts` covers all of them at once - run it
before claiming a new provider works.
