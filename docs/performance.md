# Performance baselines

earshot records performance baselines for the four surfaces [M7](roadmap.md)
names: startup, rendering, context shaping, and long-running sessions.

```bash
bun run bench                     # every surface
bun run bench --surface shaping   # one surface
bun run bench --save              # also write a JSON record to bench/baselines/
```

Startup is measured through the real binary, so `bun run build` has to have run
first.

## What this does not do

**It enforces nothing.** No case has a threshold, and the command cannot fail a
build. That is deliberate, and it is the whole reason this exists before the
regression budgets M7 asks for do.

A budget is a claim about how much a number may move before something is wrong.
Making that claim requires knowing how much the number moves when *nothing* is
wrong, and that is measured, not guessed. The first run of this harness put
process startup at a 9% spread and several in-process cases above 200% — which
turned out to be clock resolution rather than variance, and was fixed by
batching each sample. A budget picked before that distinction was visible would
have been set on the noise.

So budgets come from the recorded history, in a later change, and only for the
cases whose spread is narrow enough to detect a regression anyone would care
about.

## Reading the output

| Column | Means |
|---|---|
| `median` | Middle sample, per operation. |
| `p95` | 95th percentile by nearest rank. |
| `spread` | `(p95 - min) / median`. |
| `n` | Timed samples. Each may batch several calls; see `repeats` in the JSON. |

`spread` is the column that matters. It answers the only question this harness
is being asked yet: can this case carry a budget at all? A case whose spread is
wider than the regression worth catching cannot detect that regression on any
threshold, so it does not get one.

## Baselines

`bun run bench --save` writes one JSON file per run under `bench/baselines/`,
stamped with platform, architecture, CPU count and Bun version. One file per
run rather than one rolling file: the distribution across runs and machines is
the thing being collected, and overwriting keeps a sample of one forever.

CI records a run on Linux, macOS and Windows for every push to `main` and
uploads it as a build artifact. Those runs assert nothing — they exist so that
when budgets are set there is cross-platform history to set them from. Hosted
runners are noticeably noisier than a developer machine, which is itself a
finding the budgets will need.

## Adding a case

A case belongs to one surface and says what one iteration measures in the
reader's terms:

```ts
{
  name: 'shape/long-transcript',
  surface: 'shaping',
  what: '1200 messages, most results stubbed',
  iterations: 20,
  repeats: 20,
  run: () => shapeMessages(long, DEFAULT_SHAPER_OPTIONS),
}
```

Set `repeats` when a single call finishes in microseconds. Without it the sample
measures the timer: the duration is divided by `repeats`, so the reported median
stays a per-operation cost.

A case that allocates anything belongs to a suite with a `cleanup`, which runs
once after every case in that suite and also when a case throws. Per-case
`teardown` would delete the fixture that the next case in the suite still needs.
