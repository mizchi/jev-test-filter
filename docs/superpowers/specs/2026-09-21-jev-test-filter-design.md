# jev-test-filter — design

Status: approved 2026-09-21

## Problem

A change touches a few files; the test suite runs everything. Selecting the tests
a diff can plausibly break is a judgment call about code that no cheap static
analysis makes well, and that Jev (TypeSafe's System One model) answers in one
round trip: one `state` — the diff — plus one question per test.

The tool extracts the test inventory from the source, scores each test against
the diff, and emits the filter arguments the runner already understands.

## Scope

Frameworks: vitest (and jest, which shares vitest's filter shape), node:test,
@playwright/test. Extraction is static; a dynamically generated test that no
`test(...)` call names is out of scope.

Out of scope: running the tests itself (beyond `--exec`), coverage-based
selection, caching across diffs.

## Verified runner behaviour

These were measured, not assumed, on Node 24.21, vitest 5.0.1, @playwright/test
current. The filter layer is built on them.

| Framework | Full-name join | Selection |
| --- | --- | --- |
| vitest / jest | `" > "` | `-t '^A > B > c$'` plus file paths as positionals |
| node:test | `" "` (single space) | `--test-name-pattern '^A B c$'` plus file paths |
| @playwright/test | not used | `file:line` positionals |

Two findings drive the design:

- The join differs between vitest and node:test. `^Alpha Nested keeps one$`
  selects the test under node:test and selects nothing under vitest; the
  `" > "` spelling does the reverse. One "full name" per framework, not one
  shared one.
- node:test ORs repeated `--test-name-pattern` flags, and a pattern that
  matches a *suite* name runs every descendant of it. `^Alpha$` runs both of
  Alpha's children. So the selection must be a single alternation of
  `^full name$` alternatives, never one flag per test.
- Playwright's `--grep` matches `"<project> <file> <describe chain> <title>"`,
  so an anchored pattern has to know the project name and breaks when projects
  are added. `file:line` is exact and needs no escaping, and the line numbers
  come free from the extractor.

## Architecture

```
git diff ─┬─► diff.ts    ─► ChangedRanges + raw diff
          └─► state.ts   ─► StatePayload (one per request)
                                      │
test files ─► extract.ts ─► TestCase[] ┼─► questions.ts ─► Question x N
              (ast-grep)               │
                                  jev.ts   one state + N questions, one round trip
                                      │
                                 Answer x N
                                      │
                                  gate.ts  pure, offline, the only place with thresholds
                                      │
                                  Selection
                                      │
                                 filter.ts  per-framework argv
                                      │
                       cli.ts: stdout / --exec / --json / --replay
```

### Modules

| File | Responsibility | Depends on |
| --- | --- | --- |
| `src/types.ts` | The contract: `TestCase`, `Question`, `Answer`, `Selection` | nothing |
| `src/jev.ts` | Jev HTTP client, ported from jev-lint: `Pacer`, `askSplitting` | `fetch` |
| `src/diff.ts` | `git diff --unified=0` to line ranges plus the raw diff | `node:child_process` |
| `src/extract.ts` | ast-grep to `TestCase[]` (file, titlePath, line, endLine) | `@ast-grep/cli` |
| `src/framework.ts` | File to framework, from its import sources | nothing |
| `src/state.ts` | Diff to `state`, truncated to the 32Ki state budget | nothing |
| `src/questions.ts` | `TestCase` to a score question | `types` |
| `src/gate.ts` | `Answer` to a verdict | `types` |
| `src/filter.ts` | `Selection` to per-framework argv | `types` |
| `src/run.ts` | Orchestration; writes the answer record | all |
| `src/cli.ts` | Argument parsing, `--exec` | `run` |

Thresholds live only in `gate.ts`. Verdicts cost money and thresholds get
changed twenty times, so re-gating a recorded run has to be free — that is what
`--replay` is.

## Extraction

The ast-grep matchers are ported from jev-lint's `src/testcalls.ts`: one
`call_expression` rule covering `it` / `test` with their `x`/`f` prefixes and
their modifier chains (`.only`, `.skip`, `.each(...)`, `.skipIf(...)`,
`.fails`, `.fixme`), `Deno.test`, node:test's `t.test` subtest, and a matching
suite rule for `describe` / `suite` / `context` / `test.describe`. A suite probe
supplies the enclosing chain, so each `TestCase` carries `titlePath: string[]`
and the full name is joined per framework at the filter layer.

Framework detection reads the file's import sources: `vitest` to vitest,
`node:test` to node, `@playwright/test` to playwright, `@jest/globals` to jest.
A file whose framework cannot be determined is `unknown` and always runs.

## Scoring

One `state` per request:

```json
{ "reviewing": "a git diff",
  "changed_files": ["src/cart.ts", "src/tax.ts"],
  "stat": "...", "diff": "<unified diff>", "truncated": false }
```

One question per test, roughly 50 tokens each:

```json
{ "type": "score",
  "instructions": { "task": "...", "test_file": "src/cart.test.ts",
                    "test_name": "Cart > applyDiscount > clamps at zero",
                    "subject": "q0007" },
  "criteria": ["...", "...", "...", "..."] }
```

Criteria, as an ordered conclusion rather than a set of choices — the ordering
is the whole answer, and a `choice` would discard it:

0. Unrelated to this change; running it cannot produce a different result.
1. Touches changed code, but nothing in this change can alter its outcome.
2. Could be affected by this change; it might fail.
3. Directly exercises behaviour this change altered or broke; likely to fail.

Default cutoff is 2.0. Level 1 means the test is safe, so the boundary between
1 and 2 is the one default worth defending; it is not a tuned number.

Confidence routes, it does not gate: a test with `value >= cutoff - 1` and
`confidence < 0.5` is treated as undecided and runs. Erring toward running is
always the cheap error.

Before any question is asked, a deterministic pass selects every test whose own
body overlaps a changed range. Those tests run unconditionally and cost no
tokens.

## Fail-safe

Selection is an optimization, never a correctness gate. Each of these falls back
to running everything, with the reason on stderr:

- no API key, a Jev error, or a timeout
- a test with a missing or malformed answer (no answer is not a passing grade)
- zero tests extracted
- the diff was truncated and the selection rate is low

## CLI

```
jev-test-filter [--base <ref>] [--staged] [paths...]
  (default)  print the runner arguments on one line to stdout
  --format vitest|node|playwright|auto
  --exec -- <cmd...>      append the selection to <cmd...> and run it
  --json                  every test with its score, confidence and verdict
  --replay [file]         re-gate a recorded run at today's cutoffs; no API call
  --cutoff <n> --with-source --dry-run --concurrency <n>
```

Regex metacharacters in test names are escaped. Above a selection rate of 80%
the name pattern is dropped and the selection falls back to whole files, so a
run that keeps most of the suite does not carry a pathological alternation.

## Testing

Test-first, in this order:

1. `diff.ts` — `parseUnifiedDiff` as a pure unit.
2. `extract.ts` — fixtures per framework covering nesting, modifiers and
   `.each`, asserted against expected `TestCase[]`.
3. `framework.ts` — detection from import sources.
4. `gate.ts` — table-driven: cutoff boundaries, confidence routing, missing
   answers.
5. `filter.ts` — the generated pattern is applied as a real `RegExp` to every
   extracted name: every selected name must match and every unselected name
   must not.
6. `jev.ts` — a substituted `fetch`: the 400 `max_tokens_exceeded` split and the
   429 pacer.
7. End to end — a fixture repo with a recorded answer set under `--replay`, and
   the argv `--exec` assembles.

The project's own tests run under `node --test` against TypeScript directly;
Node 24 strips types without a flag. The vitest and Playwright fixtures exist to
be extracted from, and are never executed.

## Repository

pkfire (`Taskfile.pkl`, `.envrc`, `pkf hooks install`), secretlint on pre-push,
English README and commits, npm package `jev-test-filter` with a bin of the same
name, ESM, `engines.node >= 24`.
