# jev-test-filter

`jev-test-filter` reads a `git diff`, asks a model how much that change can
alter the outcome of every single test in the repository, and prints the filter
arguments your test runner already understands. It hands those arguments to the
runner you already use — vitest, `node --test` or Playwright — so the run
covers the tests the change could plausibly break instead of all of them.

It uses [Jev](https://typesafe.ai), TypeSafe's System One model: one shared
`state` (the diff), one question per test, one round trip. There is no agent
loop and no file reading by the model.

## Install

Requires Node 24 or newer, `git`, and a TypeSafe API key.

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
jev-test-filter: 8/89 tests selected (pattern)
✔ the node:test pattern selects exactly the chosen tests under the space spelling (0.920834ms)
✔ playwright is selected by location and every line points at a real test (1.260125ms)
▶ Cart
  ▶ applyDiscount
    ✔ clamps at zero (0.204041ms)
    ✔ rounds half up (0.039334ms)
  ✔ totals (0.033417ms)
✔ Cart (0.732333ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

**2. `--json`: the whole scoring.** Every test, with its score, its confidence
and the reason it was kept or dropped. This is the shape to read, to log, or
to feed to another program.

```
$ jev-test-filter --base main --json > selection.json
$ jev-test-filter --base main --json
{
  "framework": "node",
  "mode": "pattern",
  "argv": ["--test-name-pattern", "^(?:Cart totals|...)$", "test/fixtures/node/cart.test.cjs"],
  "fallback": null,
  "selected": 8,
  "total": 89,
  "spent": {
    "calls": 1,
    "inputTokens": 20550,
    "outputTokens": 1517,
    "ms": 650,
    "retried": 3,
    "rateLimited": 0,
    "tokensPerSecond": 200000,
    "splits": 0,
    "usd": 0.0008631
  },
  "tests": [
    {
      "file": "test/cli.test.ts",
      "name": "parseCliArgs reads the flags and the paths",
      "pattern_name": "parseCliArgs reads the flags and the paths",
      "line": 27,
      "selected": false,
      "reason": "below",
      "score": 0.37,
      "confidence": 0.63
    }
  ]
}
```

**3. Arguments on stdout.** With neither `--exec` nor `--json`, the tool writes
the runner arguments to stdout, shell-quoted, and nothing else; progress goes
to stderr. Reach for this when you want to see what it decided, or when you are
pasting the arguments into a command by hand.

```
$ jev-test-filter --base HEAD~1 --format node
jev-test-filter: 8/89 tests selected (pattern)
--test-name-pattern '^(?:Cart totals|Cart applyDiscount rounds half up)$' test/fixtures/node/cart.test.cjs
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
`.mts` or `.cts` extension.

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

Only the vitest, node:test and Playwright spellings were verified against the
real runners. `jest` is emitted with the vitest shape.

The `mode` field in `--json` names which of five shapes came out:

| `mode` | `argv` | Meaning |
| --- | --- | --- |
| `pattern` | flag, pattern, files | The normal case. |
| `locations` | `file:line`… | Playwright. |
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
--format <name>     vitest | jest | node | playwright | auto  (default: auto)
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
$ jev-test-filter --replay .jev-test-filter/last.json > /dev/null
jev-test-filter: 8/89 tests selected (pattern)

$ jev-test-filter --replay .jev-test-filter/last.json --cutoff 1.0 > /dev/null
jev-test-filter: 16/89 tests selected (pattern)
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

Measured once, on this repository: 89 tests, the diff of one commit,
`--format node`. One request, 20,550 input tokens, 1,517 output tokens,
650 ms, **$0.00086**. It selected 8 of the 89 tests, and running the arguments
it printed ran exactly those 8.

That is one measurement on one repository, not a promise. Cost scales with the
size of the diff plus the number of tests, since the diff is sent once and each
test is one question.

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
  `the selected tests span more than one framework (node, playwright, vitest);
  narrow the run with a path argument or pick one with --format`. This is the
  one failure that is not a fail-safe.
- **A test whose title is not a literal is always selected.** An interpolated
  template or a `.each` row has no name a pattern can hold. Such a test is kept
  to be safe, and because a pattern applies to the whole run rather than to one
  file, a single one of them in the selection drops the entire run to
  file-level filtering (`mode: "files"`). Still a large saving, but less than
  name-level.
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
