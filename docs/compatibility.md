# Compatibility

What earshot promises not to break, on which surfaces, and — just as importantly
— where it promises nothing yet.

Two surfaces carry a version marker and a stability rule: the headless JSON
output (`earshot.v1`) and the ACP server (ACP v1). This page states those
promises in one place and says what enforces them. Three other surfaces are
public in practice but carry no marker; they are listed at the end so nobody has
to guess which list they are on.

## The rule, in one sentence

Within a version, things may be **added**; renaming, removing, or changing the
meaning of anything already published requires a new version, and a new version
is requested by name rather than arriving in an upgrade.

That shape is what makes the promise useful. A guarantee that nothing ever
changes would stop earshot reporting anything new. A guarantee that everything
may change is not a guarantee. Additive-within-a-version is the middle that lets
both sides move: earshot adds, and a consumer that ignores what it does not
recognise keeps working.

## Headless output — `earshot.v1`

`earshot -p` with `--output-format json` or `stream-json` is an API. Every object
written to stdout carries `"schema": "earshot.v1"`.

**Promised within v1:**

- Every record carries `schema`. A consumer can identify the contract without
  knowing which binary produced it.
- New record `type`s and new fields may appear in any release. **A consumer must
  ignore record types it does not recognise and fields it did not expect.** This
  is the whole compatibility rule, and a consumer that fails on an unknown type
  has not implemented v1.
- The field names and meanings documented in [Headless output](headless.md) do
  not change within v1.
- `--output-format json@v1` is accepted and means exactly what `json` means, so
  a script can state which contract it was written against.
- The last line of `stream-json` is the same `result` object that `json` emits
  alone. A consumer reading only the final line and one parsing a single object
  are reading the same thing.
- An output format earshot does not implement is exit code 2, never a silent
  fall back to prose.

**Requires v2:** renaming a field, removing one, or changing what one means.
v2 would be requested explicitly (`--output-format json@v2`) and v1 would keep
working alongside it. An upgrade is never the thing that breaks a script.

**Explicitly not promised:** earshot's internal `AgentEvent` union is not the
wire format. It is ours to rename, and the mapping to record types exists so a
consumer cannot notice when we do. `permission` records carry the reason a call
needed approval, not the diff — the detail is for a person at a terminal.

## ACP — v1

The ACP server speaks stable ACP v1, and the protocol version it reports comes
from the protocol library rather than a string of ours, so earshot cannot claim
a version it does not implement.

**Promised:**

- `initialize` reports the ACP v1 protocol version and earshot's own version
  separately. A client negotiates against the protocol, not against a release.
- The capabilities earshot declares are a promise about behaviour:
  `loadSession` and image prompts are advertised because they work.
- A capability earshot does not declare is not silently available.
- Client-provided MCP server definitions are **rejected**, not ignored. A client
  that sends them is told, rather than being left to believe its servers loaded.

**Explicitly not promised:** draft ACP v2, and any behaviour a client infers
from earshot's version string rather than from declared capabilities.

## Surfaces with no promise yet

These are public in the sense that people can depend on them, and unversioned in
the sense that nothing here says they will not change:

| Surface | State |
|---|---|
| Configuration files (`settings.json`, and the settings schema) | No version marker. Fields may be renamed or removed. |
| Transcript format (session JSONL entries) | No version marker. Append-only on disk, but the entry shape is not frozen. |
| Extension API (in-process TypeScript extensions) | No version marker. The tool-definition shape may change. |

Naming them is the honest half of a compatibility page. Versioning them is a
larger piece of work that is not started; until it is, treat these as internal,
and expect a release to be able to change them.

## What enforces this

Prose is not a contract. The promises above are tested in
`packages/cli/test/output.test.ts` and `packages/acp/test/server.test.ts`:

- the schema string is pinned, so changing it fails a test rather than shipping
- the complete set of record types and their exact field names is locked, so a
  rename or a removal fails a test — a **new** type or field does not, which is
  the additive rule expressed as code
- `json@v1` is accepted and `json@v2` is refused, so the pinning story cannot
  rot
- ACP's declared capabilities are locked, and client MCP rejection is asserted

A test failing there is not a broken build. It is the question "is this a v2?"
being asked at the moment somebody would otherwise have answered it by accident.
