# Changelog

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
