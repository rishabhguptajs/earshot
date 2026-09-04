# Listening

> **Mostly built.** This document specified M3, which landed: behaviours 1, 2, 4,
> 5, 7, 8, 10, 11 and 12 are implemented with tests, 9 follows from the provider
> layer, and 3 (`/plan`) and 6 (the intent line) are still to come in M4. It's
> written down first because these behaviours are the reason earshot exists —
> everything else is table stakes that three other tools already do well.

## The problem

Terminal coding agents fail in a recognisable way. Not by writing bad code — by
not listening:

- You ask for a fix; it refactors three neighbouring files.
- Your request was ambiguous; it guesses, confidently, and is wrong.
- You say "use bun, not npm"; four turns later it runs `npm install`.
- It says "done"; the tests it never ran are failing.
- It goes down a wrong path and you can only watch, or kill it and re-explain.

Each is a *behaviour*, so each gets a specification and a test rather than a
paragraph of prompt text and hope.

## The twelve behaviours

### 1. Ask before guessing

When two readings of a request lead to materially different work, ask first —
2–4 concrete options, not an open question. Implemented as an `ask_user` tool plus
a system-prompt policy. Configurable: `curiosity: low | normal | high`.

The failure this prevents: twenty minutes of confident work in the wrong direction.

### 2. Scope contract

Before the first mutating tool call, the agent states its scope in one paragraph:
which files, which behaviours. Editing a file outside that scope triggers a
confirmation prompt.

Unrequested refactors, renames, new dependencies and formatting sweeps are blocked
by default — by policy text *and* by a guard, because policy text alone is not
enforcement.

The guard is deliberately not a line count. A threshold either fires on every
large change the user actually asked for or never fires on the small wrong ones,
so what it checks is categorical: a file outside the declared list, a dependency
manifest or install command, a rename or delete, a rewrite that changes no line's
content, a removed test. Size is only a backstop, floored so that a small change
is never over budget whatever the estimate said. A turn that declared no scope is
not guarded at all — a prompt on every one-line fix is the prompt fatigue this
document lists as an anti-goal.

### 3. A plan you can edit

`/plan` produces a plan file you edit in `$EDITOR` or inline before approving.
The approved plan is pinned into context for the run. A plan you can only accept
or reject is a prompt, not a plan.

### 4. Steer without stopping

Typing mid-turn queues a message injected at the next model call — you redirect
without cancelling. `Esc` interrupts. `/rewind` returns to any node in the session
tree. `/undo` reverts the last tool batch's file changes from a per-batch snapshot
held in a shadow git object store — no commits in your repository.

### 5. Preference memory with provenance

Corrections ("don't add comments", "use bun") are detected on prompt submit and
offered as one-keystroke memory candidates, scoped to the project or globally.

Each memory records **why** and **when**. When one is applied, the agent says so:
*"applying your rule: no semicolons"*. Memory you can't inspect is memory you
can't trust; `/memory` lists, edits and deletes.

### 6. Intent line

Every tool batch is preceded by a one-line "why". Enough to catch a wrong turn
after one line of output instead of forty.

### 7. Honest completion

A built-in `Stop` self-check: before finishing, compare the original request
against what actually changed, and state anything skipped, unverified or failing.

No silent narrowing of scope. If four of five items are done, that is the report —
not "done".

### 8. Verification on by default

After edits, run the project's test or lint command — declared in `AGENTS.md`, or
detected from `package.json` scripts or a Makefile — and report the output
verbatim. Not a summary of the output. The output.

### 9. Model-agnostic UX

Identical behaviour and transcript across providers. `/model` switches mid-session
while keeping context; thinking blocks convert to text for providers that can't
consume another vendor's reasoning.

### 10. Cost and context transparency

The status line always shows context percentage and session cost. `--max-cost`
and a per-session budget prompt before overrun. Cost is computed from catalog
pricing including cache reads and writes.

### 11. Trust levels, not nagging

"Always for this project" persists. Permission prompts show the actual diff or the
actual command — never a summary of it, because a summary is exactly where a bad
edit hides.

### 12. Session tree

`/fork` branches an experiment, `/tree` navigates, all in one JSONL file. Trying
something risky shouldn't cost you the conversation that got you there.

## How these are enforced

Prompt text alone doesn't produce behaviour; every item above lands as a mechanism:

| Behaviour | Mechanism |
|---|---|
| Ask before guessing | `ask_user` tool + policy |
| Scope contract | `declare_scope`, a categorical out-of-scope check, a size backstop |
| Steering | Message queue drained at the next model call |
| Undo | Per-batch shadow git snapshots |
| Memory | Files with frontmatter, index always in context |
| Honest completion | End-of-turn self-check appended to the turn |
| Verification | Detected test command, output reported verbatim |
| Context | Result caps, stubs for older results, compaction at 80% |
| Trust | Permission rules persisted per scope, deny-first |

Each gets tests. "The agent asks instead of guessing" is a testable property given
a fixed scenario, and that's how it will be treated.

## Anti-goals

- **Not a personality.** Listening is not warmth, enthusiasm or apology.
- **Not more confirmation prompts.** Prompt fatigue trains people to hit `y`.
  The aim is *fewer, better* interruptions: ask once, at the moment it matters,
  and remember the answer.
- **Not autonomy for its own sake.** A longer unattended run is not the goal if
  it means a longer wrong run.
