---
description: Select the tests the current change can break, and run them
---

Run the test suite filtered to what this change can plausibly break, using
`jev-test-filter`. Load the `jev-test-filter` skill first — it holds the
per-runner rules, and getting one wrong fails silently.

Steps:

1. Work out which runner this repository uses, and whether it has more than
   one. `package.json` scripts, `Cargo.toml`, `go.mod`.
2. Check `TYPESAFE_API_KEY` is set. If it is not, say so and stop — without it
   the tool falls back to running everything, which the user can do directly.
3. Run it with `--exec`, never by composing the command in a shell:

   ```
   jev-test-filter --base <the branch this will merge into> --format <runner> --exec -- <the repo's own test command>
   ```

   With no argument to compare against, drop `--base` and it reads the working
   tree against HEAD, which is right before committing.
4. Report the selected count against the total, and the reasons from
   `--json` if the user asks why a particular test was or was not chosen.
5. If it exits 1 on a multi-framework repository, ask which framework the user
   meant rather than guessing.

$ARGUMENTS
