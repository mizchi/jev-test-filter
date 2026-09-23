# What each runner actually does

Every line here was measured, on this machine, on Node 24.21.0, vitest 5.0.1,
`@playwright/test` (current), cargo 1.98.0 and go 1.26.2. Each was found by
running the runner, not by reading its documentation, and several contradict
what the documentation implies.

## The failure they share

None of these mistakes produces an error. A filter that does not apply gives a
**green run of the wrong tests**, at full cost, with nothing on stderr. That is
why every one of them is pinned by a test that spawns a real runner.

## vitest / jest

- A full name joins the `describe` chain and the title with `" > "`.
  `vitest list --json` prints exactly that string.
- `-t` takes one regular expression, matched against the full name. Anchor it:
  `-t 'keeps one'` also matches `also keeps one`.
- Argument order does not matter. `-t` before or after the file positionals
  both work.
- `-t ""` runs **everything**.

## node:test

- A full name joins the chain with a **single space**, not `" > "`.
  `^Alpha > Nested > keeps one$` selects nothing; `^Alpha Nested keeps one$`
  selects the test.
- **`--test-name-pattern` is silently ignored when it follows a positional.**

  ```
  node --test --test-name-pattern '^Alpha Nested keeps one$' b.test.js   -> tests 1
  node --test b.test.js --test-name-pattern '^Alpha Nested keeps one$'   -> tests 2
  ```

  Exit 0 both times. This is the single most dangerous behaviour in this
  document.
- Repeated `--test-name-pattern` flags are OR-ed, **and a pattern that matches
  a suite name runs every test under it**. `^Alpha$` runs both of Alpha's
  children. One flag holding one anchored alternation is the only safe shape.
- `--test-name-pattern ""` is rejected before the runner starts:
  `--test-name-pattern= requires an argument`, and the file is reported as a
  failing test.
- A file that matched nothing still appears in the summary as one passing
  "test" — the file-level wrapper. Do not count tests from the summary alone.

## @playwright/test

- `--grep` matches `"<project name> <file path> <describe chain> <title>"`.
  With an unnamed project the string begins with a space. An anchored pattern
  therefore has to know the project name, and breaks the moment a project is
  added to the config.
- `file:line` positionals need no escaping, and several may be listed:
  `npx playwright test a.spec.ts:4 b.spec.ts:9`. Generated rows declared on
  the same line cannot be separated by location.
- The line ast-grep reports for the `test(...)` call is the line Playwright
  reports. They agree.
- Playwright 1.58.2 supports `--list --reporter=json` and `--test-list <file>`.
  A list entry such as `[chromium] > rows.spec.cjs > Cart > row alpha` selects
  one project and one generated row, even when all rows were declared on the
  same source line. Without the project prefix the same row runs in both
  projects. The file path is relative to Playwright's `rootDir`.

## cargo test

- `cargo test -- --list` prints `module::path::name: test`, one per line, and
  it is **complete** — it includes tests a macro generated, which no static
  parse can see. It builds the test targets to do it.
- The listing mixes targets without saying which is which. `--lib` and
  `--test <name>` narrow it.
- `cargo test -- --exact A B C` accepts **several** exact names in one
  invocation. Each target applies all of them and runs the ones it has.
- A module path one segment wrong matches nothing. No warning. This is why
  names come from cargo's listing rather than from a path reconstructed out of
  the source.

## go test

- `go test -list '.*' ./...` prints **only top-level `TestXxx`**. Subtests are
  invisible to it.
- A subtest's name has its spaces replaced by underscores:
  `t.Run("clamps at zero", …)` becomes `TestApplyDiscount/clamps_at_zero`.
- Go rewrites the **pattern** too, so `-run '^TestN$/^a b$'` matches the
  subtest declared as `t.Run("a b", …)`. Either spelling works.
- Two subtests that collide after the rewrite — `"a b"` and `"a_b"` — both
  become `a_b`, the second gets `#01` appended, and **no pattern can tell them
  apart**.
- `-run` is split at `/` into one pattern per nesting level. A level pattern
  only constrains tests that *have* that level: `-run '^(TestA|TestB)$/^sub$'`
  runs all of `TestB` when `TestB` has no subtests, but filters `TestB`'s
  subtests when it does.
- **A second `-run` replaces the first.** They do not OR.

  Together with the previous point, this means "all of TestA, but only x and y
  of TestB" cannot be expressed in one `go test` invocation. Filtering per
  top-level function is the only shape that cannot under-select.
