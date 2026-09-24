---
name: jev-test-filter
description: "Use when a test suite is too slow to run whole on every change and you want to run only the tests a diff can plausibly break, when reviewing updated text snapshots, wiring test selection into CI or a pre-push hook, or composing a `jev-test-filter` command for vitest, jest, node:test, bun:test, Playwright, `cargo test` or `go test`. Triggers: `jev-test-filter`, `--verify-snapshots`, `.jev-test-filter/last.json`, `TYPESAFE_API_KEY`, `--test-name-pattern`, `-t '^(?:...)$'`, `--exact`, `go test -run`, and questions like 'only run the tests affected by this change', 'why did my -t pattern match nothing', 'which tests does this PR need'. Read it BEFORE hand-writing a runner filter argument from a selection: the full-name spelling differs per runner and a wrong one fails silently."
---

# jev-test-filter

Scores every test in a repository against a `git diff` and emits the filter
arguments the runner already understands. One `state` (the diff) plus one
question per test, answered by [Jev](https://typesafe.ai) in a single round
trip — measured at 1.3 seconds and $0.00098 for a suite of 110.

Selection is an **optimization, never a correctness gate.** Every failure path
— no API key, a Jev error, a missing answer, no tests found, a diff too large
to send whole — falls back to running everything and says why on stderr.

## Getting it

The skill is not the command. `npx jev-test-filter` runs it without installing;
`pnpm add -D jev-test-filter` puts it in the project. It needs Node 24 or newer,
`git`, and `TYPESAFE_API_KEY` in the environment; `--format rust` and
`--format go` also need `cargo` and `go` on the `PATH`.

Check for the key before recommending the tool. Without one it does not fail —
it reports that it is running everything and exits 0, which is a correct answer
and a useless one, and the user will reasonably wonder what they paid for.

## Use `--exec`. Do not compose the command by hand.

```
jev-test-filter --base main --exec -- vitest run
jev-test-filter --base main --format node --exec -- node --test
jev-test-filter --base main --format bun  --exec -- bun test
jev-test-filter --base main --format playwright --exec -- npx playwright test
jev-test-filter --verify-snapshots --json
jev-test-filter --base main --format go   --exec -- go test
jev-test-filter --base main --format rust --exec -- cargo test
```

`--exec` hands argv straight to `spawn` with no shell in between. Every other
shape has a way to go wrong:

`--verify-snapshots` is a separate read-only review of changed Vitest text
snapshots. It reports a risk score and confidence per changed `.snap` file (or
inline snapshot edit). Jev does not produce free-form reasons. It
ignores images, does not edit snapshots, and does not fail CI.

- `runner $(jev-test-filter ...)` is **broken**. Test names contain spaces, so
  the output is shell-quoted, and an unquoted `$(...)` word-splits without
  re-parsing the quotes. Use `eval "runner $(jev-test-filter ...)"` if you
  genuinely need the string.
- Building a pattern yourself from `--json` is the mistake this skill exists to
  prevent. See the table below.

## Non-negotiables

1. **Never hand-write a name pattern from a selection.** The full-name
   separator differs per runner and a wrong one matches nothing *without an
   error*: the run is green, takes full time, and nothing says the filter did
   not apply.
2. **Never put the name pattern after the file positionals for node:test.**
   `node --test a.test.js --test-name-pattern X` silently ignores the flag.
   The tool emits the flag first; keep that order if you move it.
3. **Never treat an empty pattern as "everything".** `vitest -t ""` runs the
   whole suite; `node --test --test-name-pattern ""` is rejected outright.
   "Everything" is the *absence* of the flag.
4. **A repository with more than one framework needs `--format`.** There is no
   single command that runs Vitest and Playwright, so the tool asks instead of
   guessing, and exits 1. This is the one failure that is not a fail-safe.
5. **`--format rust` is required for Rust and is never automatic.** Listing
   cargo's tests builds the test targets. The tool does not start a compile
   nobody asked for.
6. **Do not use it as a merge gate on its own.** It reduces what runs on a
   branch; the full suite still belongs somewhere before release.

## What each runner needs

Measured, not assumed. Getting a row wrong is silent.

| Runner | Full name | Selection | Watch for |
| --- | --- | --- | --- |
| vitest, jest | joined `" > "` | `-t '^(?:A\|B)$'` + files | pattern order does not matter |
| node:test | joined `" "` (one space) | `--test-name-pattern '^(?:A\|B)$'` + files | **flag must precede the files**; one flag only — a pattern matching a *suite* runs all its children |
| bun:test | joined `" "` (one space) | `--test-name-pattern '^(?:A\|B)$'` + files | The reporter shows `Cart > totals`, but the name pattern matches `Cart totals`. |
| @playwright/test | runner-listed project, file and titles | `--test-list <file>` with `--exec`; otherwise `file:line` | `--exec` first collects with `--list --reporter=json`, including generated tests and project variants. |
| cargo test | joined `"::"` | `-- --exact A B C` | names come from `cargo test -- --list`; a module path one segment wrong selects nothing |
| go test | joined `"/"` | `-run '^(?:TestA\|TestB)$'` + `./pkg` | **filters per top-level function**: `-run` takes one hierarchical pattern and a second `-run` replaces the first. Pass a bare `go test` — a `./...` you add stays in the package list and every package is compiled anyway |

Go scores per subtest — `--json` shows it — but selects whole top-level
functions, because "all of TestA, but only x of TestB" cannot be expressed and
the shape that covers TestB would drop TestA's other subtests.

## Reading a run

```
jev-test-filter: 11/89 tests selected (pattern)
```

`--json` gives every test with its `score` (0–3), `confidence`, `reason` and
`selected`. The reasons:

| reason | meaning |
| --- | --- |
| `touched` | the test's own body is in the diff — selected without asking, costs no tokens |
| `scored` | at or above the cutoff (default 2.0) |
| `unsure` | near the cutoff and the model was not confident — selected to be safe |
| `dynamic` | the title is not a literal (`.each`, an interpolated template, a table-driven `t.Run`) so it cannot be named — always selected |
| `missing` | no usable answer — selected, because no answer is not a passing grade |
| `below` | under the cutoff |

Exit codes: **0** run it, **3** nothing was selected, **2** bad arguments,
**1** the tool could not decide (the multi-framework case).

```sh
ARGS=$(jev-test-filter --base main --format node)
case $? in
  0) eval "node --test $ARGS" ;;
  3) echo "no test can be affected by this change" ;;
  *) exit 1 ;;
esac
```

## Tuning without paying again

Each successful run writes `.jev-test-filter/last.json`, and the same record to
`.jev-test-filter/records/<head_sha>.json`. A run that falls back leaves both
alone, so the last *complete* scoring is always there.

```
jev-test-filter --replay .jev-test-filter/last.json --cutoff 1.0 --json
```

Re-gates offline, no request, `spent: null`, under the gate the record was
decided under unless `--cutoff`, `--unsure-below` or `--unsure-margin` says
otherwise. Lower the cutoff to select more.
Scoring is not deterministic — boundary tests move between runs — so if a
stable selection matters, take it once and re-derive it with `--replay`.

## When it does not pay

The scoring costs about a second and a tenth of a cent, and that cost scales
with the number of tests and the size of the diff — **not** with how long the
tests take. It is worth it when a test costs more than that to run — Playwright suites, integration tests that
start a database, anything compiled. A millisecond-per-test unit suite will not
notice the saving, and the latency may exceed it.

## Details

- `references/runners.md` — the measurements behind the table, and how each
  runner was probed.
- `references/ci.md` — GitHub Actions wiring, and what to do about the
  non-determinism.
