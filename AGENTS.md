# earshot

A terminal coding agent that actually listens. TypeScript, ESM, Node >= 22 and Bun.

## Layout

- `packages/providers` - `Provider`/`WireApi` interfaces, registry, model catalog, auth store.
  Nothing here talks to the agent loop; everything above the wire speaks the unified
  types in `src/types.ts`.
- `packages/core` - agent loop, tools, permissions, context shapers, sessions, memory.
- `packages/mcp` - MCP client manager.
- `packages/tui` - Ink app.
- `packages/cli` - the `earshot` binary; the only publishable package.

## Commands

- `bun test` - test suite
- `bun run typecheck` - `tsc -b` across the project references
- `bun run lint` / `bun run format` - biome

## Conventions

- Imports use explicit `.ts` extensions; `rewriteRelativeImportExtensions` handles emit.
- `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.
  Build optional properties conditionally (`...(x !== undefined ? { x } : {})`) rather
  than assigning `undefined`.
- Adding a provider should touch one file. If it needs more, the abstraction is wrong.
- Provider-specific data that must survive a round-trip goes in `providerMetadata`,
  opaque to everything above the adapter, and is persisted verbatim in the transcript.
