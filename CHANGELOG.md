# Changelog

## Unreleased

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
