# Adding a provider

The project's stated goal is that adding a vendor is a config entry, not a
refactor. Most vendors take **one line**.

## Is it OpenAI-compatible?

Nearly every vendor is. If it accepts requests at `POST {baseUrl}/chat/completions`
in OpenAI's shape, you need no code — just a table entry.

Check quickly:

```bash
curl https://api.example.com/v1/models -H "Authorization: Bearer $KEY"
```

## The one-line path

Add an entry to
[`packages/providers/src/catalog/supported.ts`](../packages/providers/src/catalog/supported.ts):

```ts
{ id: 'groq', catalogId: 'groq', api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1' },
```

| Field | Meaning |
|---|---|
| `id` | What users type: `earshot -p "hi" --model groq/llama-3.3-70b` |
| `catalogId` | The provider's id on [models.dev](https://models.dev), which supplies models, pricing and env vars |
| `api` | Which wire adapter serves it |
| `baseUrl` | Only needed when models.dev has no `api` field for the provider |
| `envVars` | Only to override the catalog's list |
| `auth` | `api-key` (default), `oauth`, `ambient`, or `none` |
| `notice` | Shown in the UI for unofficial or limited providers |

Then regenerate the snapshot and verify:

```bash
bun run scripts/fetch-catalog.ts
bun test
earshot models groq
```

That's the whole change. Models, context windows, pricing, capabilities and
environment variable names all come from the catalog.

### If it isn't on models.dev

Supply the models yourself with `envVars` and `baseUrl`, or skip the table
entirely and let users configure it at runtime with `customProvider()` — see
[Providers](providers.md#custom-and-local-endpoints). Better still,
[contribute it to models.dev](https://github.com/anomalyco/models.dev) so
every tool benefits.

## The harder path: a new wire protocol

Only needed when a vendor isn't OpenAI-compatible.

### If an AI SDK provider package exists

Two lines in
[`packages/providers/src/wire/adapters.ts`](../packages/providers/src/wire/adapters.ts):

```ts
export const cohereWire: WireApi = createAiSdkWire('cohere-chat', (modelId, ctx) =>
  createCohere({ apiKey: key(ctx), ...common(ctx) })(modelId),
);
```

Then add `'cohere-chat'` to `WireApiKind` in `types.ts`, add the adapter to
`ALL_WIRES`, and add the package to `packages/providers/package.json` **and**
`packages/cli/package.json` (provider SDKs ship as real dependencies, not bundled).

### If no package exists

Implement `WireApi` directly — `stream(req, ctx)` yielding `StreamEvent`s. Use
the existing adapters as reference, and read
[Architecture](architecture.md#the-ai-sdk-bridge) first. This is real work: budget
for streaming edge cases, tool-call assembly, and error mapping.

## What you must not add

PRs adding these will be declined, regardless of implementation quality:

- **Claude Pro/Max subscription OAuth.** Prohibited by Anthropic's terms and
  blocked at the infrastructure level.
- **Gemini Code Assist OAuth.** Banned; endpoint deprecated.
- **Anything that circumvents a provider's terms** to reach subscription
  inference from a third-party client.

This isn't caution for its own sake — it protects users from having their
accounts suspended for using earshot.

## Verifying

Because every adapter shares one bridge, the conformance suite covers all of them
at once:

```bash
bun test packages/providers/test/conformance.test.ts
```

The table-driven tests in `builtin.test.ts` will also catch the common mistakes
automatically: an OpenAI-compatible provider with no base URL, a key-based
provider naming no environment variable, a model whose wire adapter isn't
registered.

**Test against the live API if you can.** No provider has been verified live yet,
and the conformance suite tests the bridge, not the vendor. If you have a key,
run a real turn and say so in the PR — that's more valuable than the code.

```bash
export GROQ_API_KEY=...
earshot -p "say hello" --model groq/llama-3.3-70b
```

## Checklist

- [ ] Entry in `supported.ts`
- [ ] `bun run scripts/fetch-catalog.ts` re-run and the snapshot committed
- [ ] `bun test` passes
- [ ] `earshot models <id>` lists the models
- [ ] A live request tried, and the result stated in the PR — including "couldn't, no key"
- [ ] Any quirk (no streaming tool calls, unusual limits) recorded as a `notice` and in [Providers](providers.md#known-provider-quirks)
