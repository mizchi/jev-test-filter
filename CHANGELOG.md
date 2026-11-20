# Changelog

## 0.1.5

### Fixed

- Select an edited test as `touched` when the command runs from a subdirectory of the repository. `git diff` names files from the repository root while discovery names them from the working directory, so the two never matched and a confident low score could deselect the test that was just changed. The diff and stat sent to the model still cover the whole repository, and a user's `diff.relative` no longer narrows them. (#3, thanks @kinjo1130)
- Find changed inline snapshots, and load their test sources, when `--verify-snapshots` runs from a subdirectory. Paths given on the command line are now read relative to the working directory.

### Changed

- Update `@ast-grep/napi` to 0.51, and build with TypeScript 7.

## 0.1.4

### Added

- Publish tagged releases to npm through GitHub Actions with OIDC trusted publishing and provenance.
- Support RSpec with `--format rspec`, which is required: `_spec.rb` files are not discovered without it, so a repository that runs Vitest or Jest next to RSpec keeps working unchanged. Examples are read from `*_spec.rb` sources with ast-grep (no `rspec --dry-run`, so a Rails application is never booted), and a selection is passed as `file:line` locations, one argument per file (`spec/a_spec.rb:7:11`). An example is named by its last line, because RSpec resolves a line to the declaration nearest above it and records a multi-line call at a line of its own choosing. `it_behaves_like` and `include_examples` are scored as one test per inclusion.

### Fixed

- Keep every shared example selected when `it_behaves_like` or `it_should_behave_like` has a customization block, and discover examples brought in by `include_context`.

## 0.1.3

### Added

- Add `--context <file>` to read flaker's `jev-context` v1 projection. Its `gate` values become the defaults for the gate (flags still win), tests in `skip` are not asked about and are reported with the new reason `quarantined`, and `tests[].failed_with` is added to that test's question as one factual sentence under `instructions.history`. Tests are matched on file and title path (and Playwright project), never on the line. A context of another version, or one that does not validate, exits 2.
- Add `--unsure-below <n>` and `--unsure-margin <n>`.
- Write every successful run to `.jev-test-filter/records/<head_sha>.json` as well as `last.json`.
- Export `RunRecordV1`, `RunRecordV2`, `RecordGate` and the `JevContext` types from `jev-test-filter/types`.

### Changed

- Records are now version 2, adding `head_sha`, `base_sha`, `context_digest`, `gate` (the values actually used) and `quarantined`. Version 1 records are still read, with the new fields as `null`.
- `--replay` re-gates under the record's own gate unless a flag overrides it.
- `--cutoff` and the new gate flags refuse a value that is not a finite number instead of reading it as `NaN`.

## 0.1.2

### Fixed

- Start the CLI through the `jev-test-filter` npm bin symlink, and finish writing output before exiting.

## 0.1.1

### Added

- Support `bun test` discovery and exact test-name filtering with `--format bun`.
- Collect Playwright tests from the runner with `--list --reporter=json` when using `--exec`. Generated tests and project variants are scored separately, and selected tests are passed to Playwright with `--test-list`.
- Add `--verify-snapshots` to review changed text snapshots and inline snapshots. The advisory report marks each changed file as `plausible`, `review`, or `unknown`, and supports JSON output.

### Changed

- Run the full Playwright suite if collecting its test list fails, so discovery errors do not silently omit tests.
- Include `*.vitest.*` files in source-based test discovery.
