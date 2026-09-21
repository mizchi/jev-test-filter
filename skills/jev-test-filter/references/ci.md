# Wiring it into CI

## The shape

```yaml
- name: Select tests
  env:
    TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
  run: |
    npx jev-test-filter \
      --base origin/${{ github.base_ref }} \
      --format node \
      --exec -- node --test
```

`--base <ref>` compares against the merge base, which is what a pull request
shows: commits that landed on the base branch meanwhile are not this change's
doing. The checkout needs enough history for that — `fetch-depth: 0`, or a
fetch of the base ref.

## What happens when it cannot decide

Nothing to handle. Every failure — the secret missing, the API down, a
malformed answer, a diff too large to send — runs the whole suite and writes
the reason to stderr. A CI job that would have run everything anyway is the
worst case.

The one exception is a repository whose tests span more than one framework:
that exits **1** rather than falling back, because there is no single command
to fall back to. Pass `--format`, or narrow the run with a path argument.

## Keep a full run somewhere

This tool reduces what runs *on a branch*. It is not a merge gate on its own.
Run the whole suite on the default branch, nightly, or before a release —
whatever cadence matches what a missed test would cost you.

## Non-determinism

The same diff can select 8 tests on one run and 7 on the next: tests near the
cutoff move. If a job needs a stable selection — a matrix that shards it, say —
take the selection once, publish `.jev-test-filter/last.json` as an artifact,
and have the dependent jobs re-derive it offline:

```
jev-test-filter --replay last.json --format node
```

`--replay` makes no request, reports `spent: null`, and re-gates the same
answers. `--cutoff` on a replay is how you tune without paying again.

## Cost

One request per run. Measured on jev-test-filter's own repository: 110 tests,
one commit's diff, 23,423 input tokens, 1,296 ms, $0.00098. It scales with the
number of tests and the size of the diff, not with how long the tests take.

Which is the whole argument for using it: the scoring costs the same whether
your suite takes ten seconds or forty minutes.
