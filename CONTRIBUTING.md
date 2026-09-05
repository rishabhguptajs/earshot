# Contributing to earshot

earshot is pre-1.0, which makes this a good moment to contribute: the
interfaces are still cheap to change, and a well-argued objection to a design
decision is worth more now than after it's load-bearing.

## Setup

Requires **Bun ≥ 1.3** for development and **Node ≥ 22** to verify the shipped
binary.

```bash
git clone https://github.com/rishabhguptajs/earshot
cd earshot
bun install
bun test
```

| Command | What it does |
|---|---|
| `bun test` | Run the test suite |
| `bun run typecheck` | `tsc -b` across project references |
| `bun run lint` | biome |
| `bun run format` | biome, writing fixes |
| `bun run build` | Bundle the publishable package |
| `bun run build:docs` | Build the documentation site |
| `bun run build:binaries [target]` | Build one or all standalone executables |
| `bun run smoke:npm` | Pack, globally install, and run the npm tarball in isolation |
| `bun run release:check` | Run every release-blocking automated check |
| `bun run scripts/fetch-catalog.ts` | Refresh the models.dev snapshot |

Before opening a PR, all four must pass:

```bash
bun run lint && bun run typecheck && bun test && bun run build
```

CI runs these on macOS, Linux and Windows.

## Where things live

See [Architecture](docs/architecture.md). Briefly:

```
packages/providers  wire adapters, registry, catalog, auth
packages/core       agent loop, tools, permissions, sessions
packages/mcp        MCP client
packages/tui        Ink app
packages/cli        the earshot binary
```

Dependencies point one way: `cli → tui → core → providers`.

## Good first contributions

- **Test a provider you have a key for.** Nothing has been verified against a
  live API. Report what breaks — this is the most useful thing anyone can do
  right now.
- **[Add a provider](docs/adding-a-provider.md)** — one line for most vendors.
- **A focused M6 feature.** Keep it self-contained and start with the contract in
  the [roadmap](docs/roadmap.md).
- **Windows testing** in a real terminal.

For anything large, open an issue first. A rejected PR wastes more of your time
than a rejected issue.

## Conventions

**TypeScript.** ESM, `strict`, plus `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. The last one means building optional properties
conditionally rather than assigning `undefined`:

```ts
...(x !== undefined ? { x } : {})
```

**Imports** carry explicit `.ts` extensions; `rewriteRelativeImportExtensions`
handles emit.

**Comments** explain *why*, not *what*. A comment restating the code is noise; a
comment recording a constraint that isn't visible locally is valuable:

```ts
// Cached reads are billed at the cache rate; counting them as fresh input too
// would overstate every cached turn, which is most turns in a long session.
```

**Match the surrounding code.** Naming, structure, comment density.

## Tests

Every behavioural change needs a test. The bar is a test that would fail before
your change and pass after — not a test that exercises the code.

Test names state the guarantee, not the mechanism:

```ts
test('cached reads are billed at the cache rate, not twice', ...)
test('a refusal is not reported as a normal stop', ...)
```

Provider work goes through
[`packages/providers/test/conformance.test.ts`](packages/providers/test/conformance.test.ts).
Because every adapter shares one bridge, that suite covers all of them at once —
add cases there rather than per-provider tests.

## Commits and PRs

- Present tense, explaining **why**: `Bill cached reads at the cache rate`, not
  `fix cost bug`.
- The body carries the reasoning. Non-obvious trade-offs belong in the message,
  where `git log` will find them later.
- No attribution trailers.
- Small and reviewable beats complete and enormous.

In the PR description, state what you actually verified — including what you
couldn't. "Ran a live turn against Groq" and "couldn't test live, no key" are both
useful; silence is not.

## Releases

Maintainers follow [the release and platform QA guide](docs/release.md). A release
needs `bun run release:check`, five native artifact jobs, and a recorded Windows
Terminal check. Never hand-edit generated artifacts or publish from a dirty tree.

## What won't be merged

- **Subscription workarounds** — Claude Pro/Max OAuth, Gemini Code Assist OAuth,
  or anything circumventing a provider's terms. This protects users from account
  suspension. See [Providers](docs/providers.md#deliberately-not-supported).
- **Telemetry**, analytics, or phone-home of any kind.
- **Features that make the agent less predictable** — anything widening scope on
  its own, acting without permission, or hiding what it did. See
  [Listening](docs/listening.md).
- **Vendored dependencies** where a maintained package exists.

## Reporting bugs

Include the provider and model, the exact command, the full error, and your
platform and runtime versions. If it's provider-specific, say whether you tested
against the live API — that's the difference between a bug report and a guess.

## Code of Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be decent; disagree about the work, not
the person.

## License

Contributions are licensed under [MIT](LICENSE), matching the project.
