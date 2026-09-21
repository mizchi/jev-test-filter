# jev-test-filter

`jev-test-filter` reads a `git diff`, asks a model how much that change can
alter the outcome of every single test in the repository, and prints the filter
arguments your test runner already understands. It hands those arguments to the
runner you already use — vitest, jest, `node --test`, Playwright, `cargo test`
or `go test` — so the run covers the tests the change could plausibly break
instead of all of them.

It uses [Jev](https://typesafe.ai), TypeSafe's System One model: one shared
`state` (the diff), one question per test, one round trip. There is no agent
loop and no file reading by the model.

## Install

Requires Node 24 or newer, `git`, and a TypeSafe API key. `--format rust` and
`--format go` additionally need `cargo` and `go` on the `PATH`.

```
pnpm add -D jev-test-filter
```

The package is not published yet. Until it is, run it from a clone:

```
git clone https://github.com/mizchi/jev-test-filter
cd jev-test-filter
pnpm install
pnpm run build
node dist/cli.js --help
```

## Usage

There are three invocation shapes, because "wire it in" means something
different in a shell, in another program and in a Makefile.

**1. `--exec`: run the command for you.** This is the one to reach for.
Everything after `--exec --` is your command, and the selection arguments are
appended to it. They go straight to `spawn` with no shell in between, so
nothing can be re-split or re-quoted. The command's exit code becomes the
tool's exit code.

```
$ jev-test-filter --base main --exec -- vitest run
$ jev-test-filter --base main --format node --exec -- node --test
```

Real output, on this repository:

```
$ jev-test-filter --base HEAD~1 --format node --exec -- node --test
jev-test-filter: 3/110 tests selected (pattern)
✔ parseCliArgs reads the flags and the paths (0.852375ms)
✔ a bare --replay means the record the last run left (0.121834ms)
✔ --replay still takes an explicit path either way round (0.067125ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

The commit under review changed how `--replay` parses its argument. Of 110
tests it picked the three about argument parsing, and left the other 107 —
extraction, gating, the Jev client, the Rust and Go paths — alone.

**2. `--json`: the whole scoring.** Every test, with its score, its confidence
and the reason it was kept or dropped. This is the shape to read, to log, or
to feed to another program.

```
$ jev-test-filter --base main --json > selection.json
$ jev-test-filter --base main --json
{
  "framework": "node",
  "mode": "pattern",
  "argv": ["--test-name-pattern", "^(?:parseCliArgs reads the flags and the paths|...)$", "test/cli.test.ts"],
  "fallback": null,
  "selected": 3,
  "total": 110,
  "spent": {
    "calls": 1,
    "inputTokens": 23423,
    "outputTokens": 1874,
    "ms": 1296,
    "retried": 0,
    "rateLimited": 0,
    "tokensPerSecond": 200000,
    "splits": 0,
    "usd": 0.000983766
  },
  "tests": [
    {
      "file": "test/cli.test.ts",
      "name": "a bare --replay means the record the last run left",
      "line": 89,
      "selected": true,
      "reason": "touched",
      "score": 1.74,
      "confidence": 0.19
    },
    {
      "file": "test/cli.test.ts",
      "name": "parseCliArgs reads the flags and the paths",
      "line": 27,
      "selected": true,
      "reason": "unsure",
      "score": 1.12,
      "confidence": 0
    },
    {
      "file": "test/cargo.test.ts",
      "name": "parseCargoList takes the test lines and nothing else",
      "line": 5,
      "selected": false,
      "reason": "below",
      "score": 0.01,
      "confidence": 0.99
    }
  ]
}
```

Three real entries out of the 110, and each shows a different mechanism. The
first scored 1.74 — under the cutoff of 2 — and ran anyway, because its own
body is inside the diff; `touched` costs no tokens and is decided before any
question is asked. The second scored 1.12 with a confidence of 0, and
`unsure` is the rule that confidence routes rather than gates: an uncertain
verdict near the cutoff runs. The third is what a clear no looks like.

**3. Arguments on stdout.** With neither `--exec` nor `--json`, the tool writes
the runner arguments to stdout, shell-quoted, and nothing else; progress goes
to stderr. Reach for this when you want to see what it decided, or when you are
pasting the arguments into a command by hand.

```
$ jev-test-filter --base HEAD~1 --format node
jev-test-filter: 3/110 tests selected (pattern)
--test-name-pattern '^(?:parseCliArgs reads the flags and the paths|a bare --replay means the record the last run left|--replay still takes an explicit path either way round)$' test/cli.test.ts
```

A test name contains spaces, so the arguments have to be quoted, and that
makes the line unsafe to compose with an unquoted `$(...)`:

```
# WRONG. The shell word-splits without re-parsing the quotes, so the runner
# receives several arguments where one was meant, and rejects them.
vitest run $(jev-test-filter --base main)

# Works, because eval re-parses the quoting.
eval "vitest run $(jev-test-filter --base main)"
```

An empty line on stdout is what "run everything" and "run nothing" both look
like, because both mean "no arguments". The exit code tells them apart:

| Exit | Meaning |
| --- | --- |
| 0 | Arguments were printed, or everything is to be run and there are none. Run the command. |
| 3 | Nothing was selected. Do not run the command; there is nothing to run. |
| 2 | Bad arguments, e.g. `unknown --format mocha`. |
| 1 | The tool failed, e.g. the tests span more than one framework and no `--format` was given. |

So the stdout form is used like this:

```
ARGS=$(jev-test-filter --base main --format node)
case $? in
  0) eval "node --test $ARGS" ;;
  3) echo "no test can be affected by this change" ;;
  *) exit 1 ;;
esac
```

`--exec` and `--json` always exit 0 when the tool itself succeeded, because
neither is ambiguous: `--exec` simply does not start the command and prints
`nothing selected; not running`, and `--json` reports `"mode": "none"`.

Prefer `--exec`. It exists so that nobody has to get this right.

Tests are discovered with `git ls-files`, so untracked and ignored files are
never considered. A file counts as a test file when it is named
`*.test.*` or `*.spec.*` with a `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`,
`.mts` or `.cts` extension, or when it ends in `_test.go`, which is Go's own
convention and the only one `go test` compiles into a test binary.

**Rust is the one exception: it is never discovered automatically.** Listing a
crate's tests means running `cargo test -- --list`, and that builds the test
targets. A tool that triggers a compile nobody asked for is a tool that gets
removed from the workflow, so it happens only when you write `--format rust`.
Every other language is read out of the source and costs nothing but a parse.

### Rust and Go

```
$ jev-test-filter --format go --exec -- go test
$ jev-test-filter --format rust --exec -- cargo test
```

Pass `--format` explicitly for both. For Go it is what stops a mixed
repository — Go tests next to vitest specs — from being an error, and for Rust
it is the permission to build. Do not give the runner its own package list:
the tool appends the packages (Go) or the exact names (Rust) it chose, so
`go test` and `cargo test` are the commands to hand to `--exec`.
`--exec -- go test ./...` is not an error, but `./...` stays in the package
list next to the `./pkg` the tool chose, so every package is compiled and the
package-level saving is lost — only the `-run` pattern still applies.

Go filters coarsely, and it is worth knowing before you read the numbers:
scores are per subtest, but the emitted `-run` pattern names only top-level
`TestXxx` functions, so **selecting one subtest runs all of that function's
subtests.** The reason is in [What it emits, per framework](#what-it-emits-per-framework).
Rust has no such limit: `--exact` takes one name per test, at any nesting.

Real output, on a two-package Go module where one edit broke one subtest
(go 1.26.2):

```
$ go test ./... -v                       # unfiltered: 5 tests in 2 packages
--- FAIL: TestApplyDiscount (0.00s)
    --- PASS: TestApplyDiscount/clamps_at_zero (0.00s)
    --- FAIL: TestApplyDiscount/halves_the_total (0.00s)
--- PASS: TestItemCount (0.00s)
--- PASS: TestCostIsFreeOverThreshold (0.00s)
--- PASS: TestCostBelowThreshold (0.00s)
FAIL

$ jev-test-filter --format go --exec -- go test -v
jev-test-filter: 2/5 tests selected (pattern)
--- FAIL: TestApplyDiscount (0.00s)
    --- PASS: TestApplyDiscount/clamps_at_zero (0.00s)
    --- FAIL: TestApplyDiscount/halves_the_total (0.00s)
FAIL	scratchcart/cart	0.139s
```

It emitted `-run '^(?:TestApplyDiscount)$' ./cart`: the whole `ship` package
was skipped, and so was `TestItemCount`. The break was still run.

The same crate in Rust (cargo 1.98.0):

```
$ cargo test                             # unfiltered
running 5 tests
test cart::tests::apply_discount::clamps_at_zero ... ok
test cart::tests::counts_items ... ok
test ship::tests::charged_below_threshold ... ok
test ship::tests::free_over_threshold ... ok
test cart::tests::apply_discount::halves_the_total ... FAILED
test result: FAILED. 4 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out

$ jev-test-filter --format rust --exec -- cargo test
jev-test-filter: 2/5 tests selected (exact)
running 2 tests
test cart::tests::apply_discount::clamps_at_zero ... ok
test cart::tests::apply_discount::halves_the_total ... FAILED
test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out
```

It emitted `-- --exact cart::tests::apply_discount::clamps_at_zero
cart::tests::apply_discount::halves_the_total`.

`--base <ref>` compares `<ref>...HEAD`, the way a pull request does. Without
it, the working tree against `HEAD` is used; `--staged` uses the index.

## What it emits, per framework

This is the part to get right. The runners spell a full test name differently,
and a pattern in the wrong spelling matches nothing, runs nothing, and exits
zero. The tool emits the right spelling per framework, so read this table
before you hand-edit anything it prints.

| Framework | Full name is joined with | Selection is expressed as | Order |
| --- | --- | --- | --- |
| `vitest` | `" > "` — `Cart > totals` | `-t '^(?:a > b\|c)$'` plus the files | pattern **before** the files |
| `jest` | `" > "` | `-t '^(?:...)$'` plus the files | pattern **before** the files |
| `node` | a single space — `Cart totals` | one `--test-name-pattern '^(?:a b\|c)$'` plus the files | pattern **before** the files |
| `playwright` | not used | `file:line` positionals — `e2e/cart.spec.ts:12` | positionals only |
| `rust` | `"::"` — `cart::tests::halves_the_total` | `-- --exact <name> <name>…`, one invocation | after a literal `--` |
| `go` | `"/"` — `TestApplyDiscount/halves the total` | `-run '^(?:TestA\|TestB)$'` plus the `./pkg` directories | pattern **before** the packages |

Three things in that table were measured, not assumed:

- **The name pattern is emitted before the file positionals.** Node's test
  runner silently ignores `--test-name-pattern` when it comes after a
  positional: `node --test a.test.js --test-name-pattern X` runs the whole file
  and exits 0. Vitest accepts either order, so one order serves both. If you
  reorder the arguments yourself, you lose the name-level filtering without any
  warning.
- **node:test gets exactly one `--test-name-pattern` flag** holding one anchored
  alternation. Repeated flags are OR'd, and a pattern that matches a *suite*
  name runs every test under it, so one anchored alternation of full names is
  the only shape that selects exactly the intended tests.
- **Playwright is selected by `file:line`, not by `--grep`.** Playwright's
  `--grep` matches `"<project> <file> <chain> <title>"` — the project name is
  part of the string, so an anchored pattern would have to know it and would
  break the moment a project is added. `npx playwright test a.spec.ts:4`
  selects exactly one test and several positionals may be listed.

A fourth fact, if you are ever tempted to build a pattern yourself from
`--json`: an empty name pattern is not neutral. `vitest -t ""` runs everything,
while `node --test --test-name-pattern ""` does not — on Node 24.21.0 it is
rejected outright (`--test-name-pattern= requires an argument`), the file is
reported as a failing test and the process exits 1. "Select everything" has to
be the *absence* of the flag, which is what the tool emits.

Two more, for the two compiled languages, and both were measured on
cargo 1.98.0 and go 1.26.2:

- **Rust names come from cargo, never from a path this tool assembled.** The
  names handed to `--exact` are the ones `cargo test -- --list` printed.
  `--exact` is unforgiving: a module path reconstructed one segment wrong
  matches nothing, the run is green, and nothing tells you a test was skipped.
  Because that listing builds the test targets, **`--format rust` is required
  and Rust is never discovered automatically.** ast-grep then supplies each
  listed name's file and line by matching it to a `#[test]` function, which is
  what lets a test whose own body sits in the diff be selected without being
  asked about. Targets are not narrowed: a name that exists in two of them runs
  in both, which costs time and cannot lose a test.
- **Go scores per subtest but filters per top-level function.** `go test -run`
  takes one hierarchical pattern, and a second `-run` flag *replaces* the
  first — so "all of `TestA`, but only `x` and `y` of `TestB`" cannot be said
  at all. The shape that would cover `TestB` silently drops `TestA`'s other
  subtests, and that under-selection is the one error this tool must not make.
  So the emitted pattern names the top-level functions of the selected tests
  and nothing more. **Select one subtest and you run every subtest of its
  parent.** That is the cost: within a chosen function you get no filtering,
  and the saving comes from the functions and packages that were not chosen at
  all. `--json` still reports the per-subtest score, which is the finer signal
  and what a reader wants to see.

The vitest, node:test, Playwright, Rust and Go spellings were each verified
against the real runner. `jest` is emitted with the vitest shape and was not.

The `mode` field in `--json` names which of five shapes came out:

| `mode` | `argv` | Meaning |
| --- | --- | --- |
| `pattern` | flag, pattern, files | The normal case. |
| `locations` | `file:line`… | Playwright. |
| `exact` | `--`, `--exact`, names… | Rust. Every name came from `cargo test -- --list`. |
| `files` | files | A name pattern could not express the selection, so whole files were chosen. This happens when a selected test has a non-literal title, or when more than 80% of the suite was selected and the alternation would not be worth it. |
| `all` | *(empty)* | Run everything. Either every test was selected, or a fail-safe fired. |
| `none` | *(empty)* | Nothing was selected. `--exec` does not start the command; the stdout form exits 3. |

## How a test is scored

Each test is asked one `score` question over four levels:

| Level | Name | Meaning |
| --- | --- | --- |
| 0 | `unrelated` | Running this test cannot produce a different result than before. |
| 1 | `unaffected` | It exercises code the change touched, but nothing in the change can alter its outcome. |
| 2 | `at-risk` | It could be affected: it might fail. |
| 3 | `likely-failing` | It directly exercises behaviour the change altered. |

The answer is continuous, not snapped to a level. A test is selected when its
score is at or above the cutoff, which defaults to **2.0** — the boundary
between "this change cannot alter the outcome" and "it might". `--cutoff`
moves it; a lower cutoff selects more.

Two rules sit on top of that, and both exist to fail towards running a test
rather than skipping it:

- **Confidence routes, it does not gate.** A test that scores under the cutoff,
  but within 1.0 of it, and that the model answered with a confidence below
  0.5, is selected anyway. Running a test that did not need to run costs
  seconds; skipping one that did costs a release.
- **No answer is not a passing grade.** A missing or malformed answer selects
  the test.

Scoring is not deterministic. Two runs over the same diff can disagree about a
test or two near the cutoff — on this repository, the same base gave 8 selected
tests on one run and 7 on the next. If you need a selection that is stable
across invocations, take it once and re-derive it with `--replay`.

The `reason` field on each test in `--json` says which rule decided it:
`touched` (the test's own body is inside the diff — never asked about),
`dynamic` (the title is not a literal), `scored`, `unsure`, `missing`, `below`.

## When it runs everything anyway

Selection is an optimization and never a correctness gate. Every one of the
following makes the tool give up on selecting, emit no arguments at all, and
print the reason on stderr:

```
jev-test-filter: running everything (jev failed: no API key; set TYPESAFE_API_KEY)
```

- **No API key.**
- **A Jev error, a timeout, or any other request failure.** Seen in practice:
  `running everything (jev failed: HTTP 529: ... system_overloaded ...)`. The
  client retries transient failures first; the fall-back is what is left after
  those are exhausted.
- **A missing or malformed answer** — that test is selected. If the whole
  request failed, every test is.
- **Zero tests were extracted** from the repository.
- **The diff did not fit the state budget and the selection was still small.**
  A truncated diff that deselects more than half the suite was judged from a
  state that was missing part of the change it should have judged.
- **`--dry-run`**, which extracts and reports without asking anything.

"Run everything" is expressed as *no arguments at all*, so `--exec -- vitest run`
falls back to exactly `vitest run`. Check that your bare command really does
run your whole suite: if your test script is `node --test "test/*.test.ts"`
rather than `node --test`, then `--exec -- node --test` on the fail-safe path
runs Node's default discovery, not your glob. There is no way to supply a glob
only on the fallback path: on the selected path the tool appends the files it
chose, and your glob would sit next to them and pull the whole suite back in.

A fail-safe is not an error: the exit code is 0 on every path above, because
"run everything" is a perfectly good answer. Exit 3 is not a fail-safe either —
it is the opposite, a complete scoring that selected nothing. The one condition
that really is an error is a repository whose tests span more than one
framework with no `--format`, which exits 1 (see Known limitations).

## Options

```
--base <ref>        compare against <ref>...HEAD, as a pull request does
--staged            use the staged change instead of the working tree
--format <name>     vitest | jest | node | playwright | rust | go | auto  (default: auto)
--cutoff <n>        select at or above this score level (default: 2)
--concurrency <n>   requests in flight at once (default: 32)
--json              print the full scoring instead of the arguments
--dry-run           extract and report without calling Jev
--replay <file>     re-gate a recorded run offline (default: .jev-test-filter/last.json)
--exec -- <cmd...>  append the arguments to <cmd...> and run it
-h, --help          the help text
```

Positional arguments restrict which test files are considered, e.g.
`jev-test-filter --base main src/cart test/cart.test.ts`.

## Replaying a run offline

Every run that reaches Jev writes its answers to
`.jev-test-filter/last.json`. `--replay` re-gates that record without touching
the network, which is how you tune `--cutoff` for free:

```
$ jev-test-filter --replay > /dev/null
jev-test-filter: 3/110 tests selected (pattern)

$ jev-test-filter --replay --cutoff 1.0 > /dev/null
jev-test-filter: 5/110 tests selected (pattern)
```

A replay reports `"spent": null` because it spent nothing, and it needs no API
key. It writes no new record, and `--format` has no effect on it — the
framework comes from the record.

Two things to know about the record. It is one file per repository, and every
successful run replaces it — but **only** a successful one: a run that falls
back writes nothing, so `--replay` always has the last scoring that actually
completed to work on, and an unlucky `HTTP 529` cannot destroy it. And the
record holds every test's title and file path, so add `.jev-test-filter/` to
your `.gitignore`. It never holds the API key.

## Cost and latency

Measured on this repository: 110 tests, the diff of one commit, `--format
node`. One request, 23,423 input tokens, 1,874 output tokens, **1,296 ms**,
**$0.00098**. It selected 3 of the 110, and running the arguments it printed
ran exactly those 3.

That is one measurement on one repository, not a promise. Cost scales with the
size of the diff plus the number of tests — the diff is sent once and each test
is one question, at roughly fifty tokens each — and **not** with how long the
tests take to run.

Which is the whole argument for using it. A second and a tenth of a cent buys
nothing against a unit suite that finishes in 200 ms; against a Playwright
suite, a compiled `cargo test`, or anything that starts a database, it is
returned many times over. Work out what one test costs you before wiring this
in.

## Known limitations

- **The stdout form is shell-quoted and needs `eval`.** An unquoted
  `runner $(jev-test-filter ...)` splits a quoted test name into several
  arguments and the runner rejects it — vitest answers
  `Expected a single value for option "-t, --testNamePattern <pattern>"`.
  `--exec` passes argv straight to `spawn` with no shell in between and has no
  such hazard, which is why it leads this document.
- **An empty name pattern is not neutral**, so never build one by hand from
  `--json`: `vitest -t ""` runs everything, and
  `node --test --test-name-pattern ""` runs nothing (on Node 24.21.0 it fails
  to start at all). Absence of the flag is the only way to say "everything".
- **A repository whose tests span more than one framework needs `--format`.**
  There is no single command that runs vitest and Playwright together, so the
  tool refuses to guess and asks instead. It exits 1 with
  `the selected tests span more than one framework (node, go, playwright,
  vitest); narrow the run with a path argument or pick one with --format`.
  This is the one failure that is not a fail-safe. This repository is itself
  such a repository — its fixtures cover four runners — so every command above
  that is run here passes `--format`.
- **A test whose title is not a literal is always selected.** An interpolated
  template or a `.each` row has no name a pattern can hold. Such a test is kept
  to be safe, and because a pattern applies to the whole run rather than to one
  file, a single one of them in the selection drops the entire run to
  file-level filtering (`mode: "files"`). Still a large saving, but less than
  name-level.
- **A Go subtest whose name is not a literal cannot be named**, and its parent
  is selected whole. That is the table-driven idiom, so it is common. Worse,
  `go test` rewrites a subtest's spaces into underscores when it reports and
  matches it, so two subtests named `"a b"` and `"a_b"` collide, get `#01`
  appended, and cannot be told apart by name **at all** — not by this tool and
  not by a `-run` pattern you write yourself. Selecting whole top-level
  functions is the answer to both.
- **A Rust test a macro generated is listed by cargo but has no location.** An
  `rstest` case, or anything else a macro produced, appears in
  `cargo test -- --list` but matches no `#[test]` function in the source, so it
  keeps no file and no line. No changed range can overlap it, which means it is
  *scored* like any other test rather than selected for free when the diff
  touches it. It is never dropped for want of a location — a missing answer
  still selects.
- **`@ast-grep/lang-rust` and `@ast-grep/lang-go` ship prebuilt binaries, and
  their install scripts are commonly skipped.** pnpm 10 blocks `postinstall`
  by default, and both packages use one. That is harmless wherever
  `node_modules/@ast-grep/lang-<name>/prebuilds/` already holds a build for
  your platform — Linux and macOS on x64 and arm64, and Windows x64 — which is
  why it works here with the script never having run. If `--format rust` or
  `--format go` extracts nothing on some other platform, check that directory
  first, and allow the build with `pnpm approve-builds`.
- **Selection is static.** Tests are read from the source with ast-grep, and
  the model judges what the source shows. A test that reaches the changed code
  only through a runtime indirection — a plugin registry, a dependency-injected
  implementation chosen at startup, a fixture loaded by name — is judged on
  what the source shows, and may be dropped.

## Environment

| Variable | Meaning |
| --- | --- |
| `TYPESAFE_API_KEY` | The API key. Required unless `--dry-run` or `--replay`. `TYPESAFEAI_API_KEY` is accepted as a second spelling. |
| `TYPESAFE_BASE_URL` | Override the API endpoint. Default `https://api.typesafe.ai`. `TYPESAFEAI_BASE_URL` is also accepted. |
| `JEV_TEST_FILTER_MODEL` | The model to ask. Default `jev-latest`. |
| `JEV_TEST_FILTER_TOKENS_PER_SECOND` | Client-side pacing rate. Default `200000`. |
| `JEV_TEST_FILTER_TOKEN_BURST` | Client-side pacing burst. Default `1200000`. |

The key is only ever sent to the API endpoint as an `Authorization` header. It
is never written to the record, to `--json`, or to any log line.

## Development

```
pnpm install
pkf run check     # typecheck + tests
pkf run build
```

`pkf hooks install` wires the pre-push gate, which runs secretlint over the
outgoing diff and then `check`. `.envrc` does the same on `cd`.

## License

MIT. See [LICENSE](./LICENSE).
