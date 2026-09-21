# jev-test-filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI that scores every test in a repository against a `git diff` with Jev and emits the filter arguments vitest, node:test or Playwright already understand.

**Architecture:** `extract.ts` pulls the test inventory out of the source with ast-grep; `run.ts` sends the diff once as Jev's `state` and one question per test; `gate.ts` turns the answers into a selection with the only thresholds in the program; `filter.ts` renders that selection as per-framework argv. Every layer between the network and the argv is a pure function, so a recorded run can be re-gated offline.

**Tech Stack:** Node 24 (native TypeScript type stripping, `node --test`), `@ast-grep/napi`, pnpm, pkfire (`Taskfile.pkl`), secretlint. No runtime dependency other than `@ast-grep/napi`.

**Spec:** `docs/superpowers/specs/2026-09-21-jev-test-filter-design.md`

---

## Facts verified before this plan was written

Do not re-derive these; they were measured on this machine.

- Full test names join differently per framework: vitest uses `" > "`, node:test uses a single `" "`. A pattern in the wrong spelling silently selects nothing.
- node:test ORs repeated `--test-name-pattern` flags, and a pattern matching a *suite* name runs all of its descendants. Emit exactly one flag holding one alternation.
- Playwright's `--grep` matches `"<project> <file> <chain> <title>"`, which includes the project name. Use `file:line` positionals instead; `npx playwright test a.spec.ts:4` selects exactly one test and several may be listed.
- `@ast-grep/napi` accepts the same rule objects as the YAML rules, `SgNode#range()` returns `{start:{line,column,index},end:{...}}` with 0-based lines, and `getMatch("TITLE").text()` returns the literal **including its quotes**.
- `node --test "test/**/*.test.ts"` runs TypeScript directly on Node 24 with no flag.
- `pkf` 0.12.0 runs a `Taskfile.pkl` that amends `pkfire@0.12.3`.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | The contract: `Framework`, `TestCase`, `Answer`, `Verdict`, `Selection`, `testId` |
| `src/diff.ts` | `git diff` to changed line ranges and the raw diff text |
| `src/framework.ts` | Test-file discovery, grammar choice, per-file framework detection |
| `src/extract.ts` | ast-grep rules and `extractTests` |
| `src/state.ts` | Diff to a Jev `state` inside the 32Ki budget |
| `src/questions.ts` | `TestCase` to a score question; answer parsing |
| `src/gate.ts` | Answers to a `Selection`; the only thresholds in the program |
| `src/filter.ts` | `Selection` to per-framework argv |
| `src/jev.ts` | Jev HTTP client, ported from jev-lint |
| `src/run.ts` | Orchestration, the answer record, `replay` |
| `src/cli.ts` | Argument parsing, `--exec`, `--json`, output |
| `test/*.test.ts` | One test file per source module |
| `test/fixtures/**` | Test sources the extractor reads |

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.envrc`, `Taskfile.pkl`, `.secretlintrc.json`, `.secretlintignore`

(`README.md` and `LICENSE` are Task 14; nothing here creates them.)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "jev-test-filter",
  "version": "0.0.0",
  "description": "Score every test against a git diff with Jev, and emit the filter arguments your runner already understands",
  "keywords": ["test", "vitest", "node:test", "playwright", "test-selection", "jev", "ast-grep"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/mizchi/jev-test-filter.git" },
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "jev-test-filter": "dist/cli.js" },
  "main": "./dist/run.js",
  "types": "./dist/run.d.ts",
  "exports": {
    ".": { "types": "./dist/run.d.ts", "default": "./dist/run.js" },
    "./types": { "types": "./dist/types.d.ts", "default": "./dist/types.js" },
    "./gate": { "types": "./dist/gate.d.ts", "default": "./dist/gate.js" },
    "./filter": { "types": "./dist/filter.d.ts", "default": "./dist/filter.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc && node -e \"require('fs').chmodSync('dist/cli.js', 0o755)\"",
    "typecheck": "tsc --noEmit",
    "test": "node --test \"test/*.test.ts\"",
    "prepack": "npm run build"
  },
  "dependencies": { "@ast-grep/napi": "^0.40.0" },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "secretlint": "^9.0.0",
    "@secretlint/secretlint-rule-preset-recommend": "^9.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

`allowImportingTsExtensions` is required because the sources import each other with the `.ts` extension, which is what makes `node --test` able to run them without a build.

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "declaration": true,
    "rewriteRelativeImportExtensions": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `pnpm install`
Expected: a `pnpm-lock.yaml` is written and `node_modules/@ast-grep/napi` exists.

- [ ] **Step 4: Write `.secretlintrc.json` and `.secretlintignore`**

```json
{ "rules": [{ "id": "@secretlint/secretlint-rule-preset-recommend" }] }
```

`.secretlintignore`:

```
node_modules/
dist/
pnpm-lock.yaml
```

- [ ] **Step 5: Write `Taskfile.pkl`**

```pkl
/// Tasks for jev-test-filter.
///
/// After cloning:
///
///   pnpm install
///   pkf hooks install
///
/// That writes `.git/hooks/pre-push` to call `pkf run pre-push`. Re-running it
/// is idempotent, and `.envrc` performs the same call so `cd` into a fresh
/// clone is enough. The pre-push gate scans the outgoing diff for secrets.
amends "package://pkg.pkl-lang.org/github.com/mizchi/pkfire/pkfire@0.12.3#/Taskfile.pkl"

/// Type-check the sources without emitting.
local typecheck: Task = new {
  name = "typecheck"
  description = "tsc --noEmit"
  cmd = "pnpm exec tsc --noEmit"
  inputs {
    "src/**/*.ts"
    "tsconfig.json"
    "package.json"
  }
  cache = false
}

/// Unit tests. Node 24 strips the types, so the sources run unbuilt.
local test: Task = new {
  name = "test"
  description = "node --test over test/*.test.ts"
  cmd = "node --test \"test/*.test.ts\""
  inputs {
    "src/**/*.ts"
    "test/**/*"
    "package.json"
  }
  cache = false
}

/// Emit `dist/`.
local build: Task = new {
  name = "build"
  description = "tsc"
  cmd = "pnpm run build"
  inputs {
    "src/**/*.ts"
    "tsconfig.json"
  }
  outputs {
    "dist/**/*"
  }
}

/// Secret-leak gate over the about-to-be-pushed diff. See pkfire recipe 14.
local secretlint: Task = new {
  name = "lint:secretlint"
  description = "Run secretlint against files in the diff about to be pushed"
  cmd =
    #"""
    set -euo pipefail
    upstream=$(git rev-parse --symbolic-full-name '@{push}' 2>/dev/null \
            || git rev-parse --symbolic-full-name '@{u}' 2>/dev/null \
            || true)
    emit_files() {
      if [ -n "$upstream" ]; then
        git diff --name-only --diff-filter=ACMR -z "${upstream}..HEAD"
      else
        git ls-files -z
      fi
    }
    if [ -z "$(emit_files | tr -d '\0')" ]; then
      exit 0
    fi
    emit_files | xargs -0 pnpm exec secretlint --
    """#
  cache = false
  inputs {
    ".secretlintrc.json"
    ".secretlintignore"
    "package.json"
    "pnpm-lock.yaml"
  }
}

/// Everything a change has to pass locally.
local check: Task = new {
  name = "check"
  description = "typecheck + test"
  cmd = "echo check ok"
  cache = false
  deps { typecheck; test }
}

/// Pre-push hook target. `pkf hooks install` wires `.git/hooks/pre-push` to
/// this. Thin aggregator so more gates can be added later.
local prePush: Task = new {
  name = "pre-push"
  description = "Pre-push gate: secretlint over the outgoing diff, then check"
  cmd = "echo pre-push ok"
  cache = false
  deps { secretlint; check }
}

tasks { typecheck; test; build; secretlint; check; prePush }
```

- [ ] **Step 6: Write `.envrc`**

```sh
# Project-local node binaries (tsc, secretlint, …) without `pnpm exec`.
PATH_add ./node_modules/.bin

# Idempotently install the git hooks declared in Taskfile.pkl. pkf skips when
# the shim is already correct, so this is safe to run on every `cd`.
if has pkf; then
  pkf hooks install >/dev/null 2>&1 || true
fi

# Local overrides (TYPESAFE_API_KEY etc.) when present. Never commit .env.local.
dotenv_if_exists .env.local
```

- [ ] **Step 7: Verify the task runner**

Run: `pkf run typecheck`
Expected: tsc reports `TS18003: No inputs were found` and exits 2, because `src/` is still empty. That is the correct outcome here and resolves itself in Task 2. If pkl fails to resolve the package, the message names the version; do not change anything else.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold the package, tsconfig, pkfire tasks and secretlint gate"
```

---

## Task 2: The contract (`src/types.ts`)

**Files:**
- Create: `src/types.ts`
- Test: `test/types.test.ts`

- [ ] **Step 1: Write the failing test**

`test/types.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { testId } from "../src/types.ts";
import type { TestCase } from "../src/types.ts";

const base: TestCase = {
  file: "src/cart.test.ts",
  titlePath: ["Cart", "applyDiscount", "clamps at zero"],
  line: 12,
  endLine: 18,
  framework: "vitest",
  dynamic: false,
};

test("testId is stable for the same test", () => {
  assert.equal(testId(base), testId({ ...base }));
});

test("testId separates two tests with the same name at different lines", () => {
  assert.notEqual(testId(base), testId({ ...base, line: 40 }));
});

test("testId separates a nested title from a flattened one", () => {
  const flattened: TestCase = { ...base, titlePath: ["Cart applyDiscount clamps at zero"] };
  assert.notEqual(testId(base), testId(flattened));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/types.test.ts`
Expected: FAIL, `Cannot find module '../src/types.ts'`.

- [ ] **Step 3: Write the implementation**

`src/types.ts`:

```ts
/**
 * The contract every other module speaks.
 *
 * Nothing here reaches the network or the filesystem, so a test of any layer
 * can build its own inputs by hand.
 */

/**
 * Which runner a test belongs to. It decides how the full name is spelled and
 * which flag carries the selection, so it is carried per test rather than per
 * run: a repository with both Vitest unit tests and Playwright specs is normal.
 *
 * `jest` is separate from `vitest` only so a report can name it; the two share
 * a filter shape exactly.
 */
export type Framework = "vitest" | "jest" | "node" | "playwright" | "unknown";

/** One test, as the source declares it. */
export interface TestCase {
  /** Repository-relative, POSIX separators. */
  file: string;
  /** The enclosing suites outermost first, then the test's own title. */
  titlePath: string[];
  /** 1-based and inclusive: the range of the test call itself. */
  line: number;
  endLine: number;
  framework: Framework;
  /**
   * The title could not be read statically -- a template with an
   * interpolation, or a `.each` row. Such a test can never be named in a
   * `-t` pattern, so it is always selected and it forces the whole run down
   * to file-level filtering.
   */
  dynamic: boolean;
}

/** A usable answer to one question. Absent rather than zero when unusable. */
export interface Answer {
  /** The score level, 0 to 3. */
  value: number;
  /** How sure the model is. Routes an uncertain verdict; never gates one. */
  confidence: number | null;
}

/**
 * Why a test ended up on the side it did. Reported, not just logged: a
 * selection nobody can explain is one nobody will trust enough to leave on.
 */
export type Reason =
  /** The test's own body is inside the diff. Selected without asking. */
  | "touched"
  /** The title is not statically knowable. Selected to be safe. */
  | "dynamic"
  /** The score reached the cutoff. */
  | "scored"
  /** Near the cutoff and the model was unsure. Selected to be safe. */
  | "unsure"
  /** No usable answer came back. Selected to be safe. */
  | "missing"
  /** The score was under the cutoff. Not selected. */
  | "below";

export interface Verdict {
  /** The question this test was asked under, e.g. `q0007`. */
  id: string;
  test: TestCase;
  answer: Answer | null;
  reason: Reason;
  selected: boolean;
}

export interface Selection {
  verdicts: Verdict[];
  selected: TestCase[];
  all: TestCase[];
  /**
   * Non-null when the run gave up on selecting and everything is to be run.
   * The string is the reason, shown to the user.
   */
  fallback: string | null;
}

/**
 * A stable key for one test.
 *
 * The line is part of it because two tests in one file may legitimately share
 * a full name, and a key that collides would let one test's answer decide the
 * other's fate. The unit separator cannot occur in a JavaScript string
 * literal a source file actually contains, so the three parts cannot be
 * confused with one another.
 */
export function testId(t: TestCase): string {
  return `${t.file}\u001f${t.titlePath.join("\u001f")}\u001f${t.line}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/types.test.ts`
Expected: PASS, `pass 3`.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/types.test.ts
git commit -m "feat: add the shared contract types"
```

---

## Task 3: Diff parsing (`src/diff.ts`)

**Files:**
- Create: `src/diff.ts`
- Test: `test/diff.test.ts`

- [ ] **Step 1: Write the failing test**

`test/diff.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, touchesChange, splitDiffByFile } from "../src/diff.ts";

const DIFF = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -10,0 +11,3 @@",
  "+  const a = 1;",
  "+  const b = 2;",
  "+  const c = 3;",
  "@@ -30,2 +34,1 @@",
  "-  old();",
  "-  old();",
  "+  fresh();",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,4 +0,0 @@",
  "-  everything();",
].join("\n");

test("parseUnifiedDiff reads post-image ranges per file", () => {
  const ranges = parseUnifiedDiff(DIFF);
  assert.deepEqual(ranges.get("src/cart.ts"), [[11, 13], [34, 34]]);
});

test("parseUnifiedDiff drops a file that is only deleted", () => {
  assert.equal(parseUnifiedDiff(DIFF).has("src/gone.ts"), false);
});

test("parseUnifiedDiff merges adjacent hunks", () => {
  const d = "+++ b/a.ts\n@@ -1,1 +1,2 @@\n@@ -5,1 +3,1 @@\n";
  assert.deepEqual(parseUnifiedDiff(d).get("a.ts"), [[1, 3]]);
});

test("parseUnifiedDiff strips a mnemonic prefix", () => {
  const d = "+++ w/a.ts\n@@ -1,1 +7,1 @@\n";
  assert.deepEqual(parseUnifiedDiff(d).get("a.ts"), [[7, 7]]);
});

test("touchesChange is true when the test's range overlaps a hunk", () => {
  const ranges = parseUnifiedDiff(DIFF);
  assert.equal(touchesChange(ranges, "src/cart.ts", 9, 12), true);
  assert.equal(touchesChange(ranges, "src/cart.ts", 1, 9), false);
  assert.equal(touchesChange(ranges, "src/other.ts", 11, 13), false);
});

test("parseUnifiedDiff is not fooled by an added line that looks like a header", () => {
  const d = ["diff --git a/a.cc b/a.cc", "--- a/a.cc", "+++ b/a.cc", "@@ -1,0 +5,1 @@", "+++ x;"].join("\n");
  const ranges = parseUnifiedDiff(d);
  assert.deepEqual(ranges.get("a.cc"), [[5, 5]]);
  assert.equal(ranges.has("x;"), false);
});

test("splitDiffByFile keeps each file's own section", () => {
  const parts = splitDiffByFile(DIFF);
  assert.deepEqual([...parts.keys()], ["src/cart.ts", "src/gone.ts"]);
  assert.match(parts.get("src/cart.ts")!, /fresh\(\)/);
  assert.equal(parts.get("src/cart.ts")!.includes("everything()"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/diff.test.ts`
Expected: FAIL, `Cannot find module '../src/diff.ts'`.

- [ ] **Step 3: Write the implementation**

`src/diff.ts`:

```ts
/**
 * What the change touched.
 *
 * Two things come out of one `git diff`: the post-image line ranges, which
 * decide which tests are selected without asking, and the diff text itself,
 * which is the `state` every question is asked against.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Post-image line ranges per file, inclusive at both ends. */
export type ChangedRanges = Map<string, Array<[number, number]>>;

/** git's own prefixes, including the `diff.mnemonicPrefix` spellings. */
const PREFIX = /^[abciwo]\//;

/**
 * Parse the `@@ -a,b +c,d @@` headers of a unified diff.
 *
 * A file header is only read before the section's first hunk. Inside a hunk
 * every line carries an added or removed marker, so adding the C++ line
 * `++ x;` produces a body line spelled `+++ x;` -- indistinguishable from a
 * file header to anything that does not track where it is.
 */
export function parseUnifiedDiff(text: string): ChangedRanges {
  const byFile: ChangedRanges = new Map();
  let file: string | null = null;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      // A post-image of /dev/null is a deletion: nothing in the new tree
      // changed, so there is no line here a test's body can overlap. The
      // deletion still reaches the model, through `splitDiffByFile`.
      file = path === "/dev/null" ? null : path.replace(PREFIX, "");
      if (file && !byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (!line.startsWith("@@")) continue;
    inHunk = true;
    if (!file) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    byFile.get(file)!.push([start, start + count - 1]);
  }
  for (const [k, ranges] of byFile) {
    if (ranges.length === 0) byFile.delete(k);
    else byFile.set(k, merge(ranges));
  }
  return byFile;
}

function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]!];
  for (const [s, e] of sorted.slice(1)) {
    const last = out.at(-1)!;
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Does `[line, endLine]` intersect any changed range for this file? */
export function touchesChange(ranges: ChangedRanges, file: string, line: number, endLine: number): boolean {
  const list = ranges.get(file);
  if (!list) return false;
  return list.some(([s, e]) => line <= e && endLine >= s);
}

/**
 * The diff cut into one section per file, keyed by post-image path -- or, for
 * a file the change deletes, by its pre-image path.
 *
 * This is where `parseUnifiedDiff` and this function deliberately part ways.
 * Ranges answer "which test bodies did the change touch", and a deleted file
 * has no post-image line any test body can sit on. Sections answer "what
 * should the model see", and deleting a source file is one of the changes
 * most likely to break a test -- dropping it would hide the change from the
 * judgment it matters most to.
 *
 * The state builder drops whole sections to fit its budget, and a section is
 * the smallest piece that still reads as a diff.
 */
export function splitDiffByFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  let buf: string[] = [];
  let post: string | null = null;
  let pre: string | null = null;
  let inHunk = false;
  const flush = () => {
    const key = post ?? pre;
    if (key && buf.length > 0) out.set(key, buf.join("\n"));
    buf = [];
    post = null;
    pre = null;
    inHunk = false;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      buf.push(line);
      continue;
    }
    buf.push(line);
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    // Headers only before the first hunk; see `parseUnifiedDiff`.
    if (inHunk) continue;
    if (line.startsWith("--- ")) {
      const path = line.slice(4).trim();
      pre = path === "/dev/null" ? null : path.replace(PREFIX, "");
    } else if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      post = path === "/dev/null" ? null : path.replace(PREFIX, "");
    }
  }
  flush();
  return out;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export interface DiffOptions {
  cwd?: string;
  /** Compare against the merge base with this ref, the way a pull request does. */
  base?: string | null;
  staged?: boolean;
}

export interface Diff {
  /** The unified diff, zero context, for the `state`. */
  text: string;
  /** `git diff --stat`, which survives truncation of the text. */
  stat: string;
  ranges: ChangedRanges;
}

/**
 * The change under review.
 *
 * With `base`, `base...HEAD` -- commits that landed on the base branch
 * meanwhile are not this change's doing. Without it, the working tree against
 * HEAD, so a selection can be taken before anything is committed.
 *
 * The prefixes are pinned because a user's `diff.mnemonicPrefix` would
 * otherwise rename them and the parser's paths would match no file.
 */
export async function loadDiff({ cwd = process.cwd(), base = null, staged = false }: DiffOptions = {}): Promise<Diff> {
  // Deletions are NOT filtered out. `parseUnifiedDiff` already drops them
  // from the ranges, because a deleted file has no post-image line for a test
  // body to overlap; but removing a source file is exactly the kind of change
  // the model has to see, so it stays in the text.
  const common = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
  const range: string[] = [];
  if (staged) range.push("--cached");
  if (base) range.push(`${base}...HEAD`);
  else if (!staged) range.push("HEAD");

  const text = await git(["diff", "--unified=0", ...common, ...range], cwd);
  const stat = await git(["diff", "--stat", ...common, ...range], cwd);
  return { text, stat, ranges: parseUnifiedDiff(text) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/diff.test.ts`
Expected: PASS, `pass 7`.

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts test/diff.test.ts
git commit -m "feat: read changed line ranges and the diff text from git"
```

---

## Task 4: Framework detection and test-file discovery (`src/framework.ts`)

**Files:**
- Create: `src/framework.ts`
- Test: `test/framework.test.ts`

- [ ] **Step 1: Write the failing test**

`test/framework.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Lang } from "@ast-grep/napi";
import { detectFramework, isTestFile, langFor } from "../src/framework.ts";

test("detectFramework reads the import source", () => {
  assert.equal(detectFramework("import { it } from 'vitest';"), "vitest");
  assert.equal(detectFramework('import { test } from "node:test";'), "node");
  assert.equal(detectFramework("import { test } from '@playwright/test';"), "playwright");
  assert.equal(detectFramework("import { it } from '@jest/globals';"), "jest");
});

test("detectFramework handles require and re-exports", () => {
  assert.equal(detectFramework("const { test } = require('node:test');"), "node");
  assert.equal(detectFramework("export * from 'vitest';"), "vitest");
});

test("detectFramework returns unknown when nothing is imported", () => {
  assert.equal(detectFramework("describe('x', () => {});"), "unknown");
});

test("detectFramework prefers playwright when a file imports both", () => {
  const src = "import { test } from '@playwright/test';\nimport { expect } from 'vitest';";
  assert.equal(detectFramework(src), "playwright");
});

test("detectFramework ignores an import inside a string literal", () => {
  // This tool's own test files carry fixture sources as template literals. A
  // regular expression over the text reads those as real imports, which made
  // this repository look like it held Playwright specs it does not have.
  const src = [
    'import { test } from "node:test";',
    "const fixture = `",
    '  import { test } from "@playwright/test";',
    "`;",
  ].join("\n");
  assert.equal(detectFramework(src), "node");
});

test("langFor picks the grammar from the extension", () => {
  assert.equal(langFor("a.tsx"), Lang.Tsx);
  assert.equal(langFor("a.jsx"), Lang.Tsx);
  assert.equal(langFor("a.ts"), Lang.TypeScript);
  assert.equal(langFor("a.mts"), Lang.TypeScript);
  assert.equal(langFor("a.js"), Lang.JavaScript);
});

test("isTestFile accepts the usual spellings and rejects sources", () => {
  assert.equal(isTestFile("src/cart.test.ts"), true);
  assert.equal(isTestFile("e2e/login.spec.tsx"), true);
  assert.equal(isTestFile("test/a.test.mjs"), true);
  assert.equal(isTestFile("src/cart.ts"), false);
  assert.equal(isTestFile("src/testing.ts"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/framework.test.ts`
Expected: FAIL, `Cannot find module '../src/framework.ts'`.

- [ ] **Step 3: Write the implementation**

`src/framework.ts`:

```ts
/**
 * Which runner a file's tests belong to, and which files to look in.
 *
 * Detection is by import source rather than by configuration, because the
 * configuration says what the project runs and the import says what this file
 * is. A repository with Vitest unit tests and Playwright specs has both, and
 * a per-run answer would be wrong for half of it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, Lang } from "@ast-grep/napi";
import type { Framework } from "./types.ts";

const execFileAsync = promisify(execFile);

/** The grammar to parse a file under, by extension. */
export function langFor(file: string): Lang {
  if (/\.tsx$/.test(file)) return Lang.Tsx;
  if (/\.jsx$/.test(file)) return Lang.Tsx;
  if (/\.[cm]?ts$/.test(file)) return Lang.TypeScript;
  return Lang.JavaScript;
}

/** `foo.test.ts`, `foo.spec.tsx`, `foo.test.mjs`, and the rest of the family. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

/** `require("x")`, with the specifier captured. */
const REQUIRE_RULE = {
  kind: "call_expression",
  all: [
    { has: { field: "function", regex: "^require$" } },
    { has: { field: "arguments", has: { nthChild: 1, kind: "string", pattern: "$SPEC" } } },
  ],
};

/** A string literal's text, without its quotes. */
function unquote(raw: string): string {
  return raw.slice(1, -1);
}

/**
 * Every module specifier the file imports or requires.
 *
 * A parse, not a regular expression. The first version of this matched
 * specifiers in the text, which reads an import written inside a string
 * literal as a real one -- and this tool's own test files carry fixture
 * sources as template literals, so its own repository looked like it held
 * Playwright specs it does not have. There is no way to tell code from a
 * string without parsing, so it parses.
 *
 * The file is parsed once here and once more by the extractor. Tree-sitter is
 * fast enough that the second parse does not show up next to reading the file
 * off disk, and threading a parsed tree between the two would put the grammar
 * choice in the caller.
 */
function specifiers(source: string, file: string): string[] {
  const root = parse(langFor(file), source).root();
  const out: string[] = [];
  for (const kind of ["import_statement", "export_statement"]) {
    for (const node of root.findAll({ rule: { kind } as never })) {
      const src = node.field("source")?.text();
      if (src) out.push(unquote(src));
    }
  }
  for (const node of root.findAll({ rule: REQUIRE_RULE as never })) {
    const spec = node.getMatch("SPEC")?.text();
    if (spec) out.push(unquote(spec));
  }
  return out;
}

/**
 * Playwright wins a tie because a spec that imports `expect` from elsewhere
 * is still a Playwright spec, and selecting a Playwright test by name is the
 * one thing that does not work.
 *
 * `file` only picks the grammar; the default suits a bare source string.
 */
export function detectFramework(source: string, file = "a.ts"): Framework {
  let vitest = false;
  let node = false;
  let jest = false;
  for (const spec of specifiers(source, file)) {
    if (spec === "@playwright/test" || spec.startsWith("@playwright/test/")) return "playwright";
    if (spec === "vitest" || spec.startsWith("vitest/")) vitest = true;
    else if (spec === "node:test") node = true;
    else if (spec === "@jest/globals") jest = true;
  }
  if (vitest) return "vitest";
  if (node) return "node";
  if (jest) return "jest";
  return "unknown";
}

/**
 * The test files to consider.
 *
 * `git ls-files` rather than a directory walk: it honours `.gitignore` for
 * free, and a file git does not track is not one a CI run would execute.
 */
export async function findTestFiles(cwd: string, paths: string[] = []): Promise<string[]> {
  const args = ["ls-files", "-z", "--", ...(paths.length > 0 ? paths : ["."])];
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter((f) => f !== "" && isTestFile(f));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/framework.test.ts`
Expected: PASS, `pass 7`.

- [ ] **Step 5: Commit**

```bash
git add src/framework.ts test/framework.test.ts
git commit -m "feat: detect a test file's framework from its imports"
```

---

## Task 5: Test extraction (`src/extract.ts`)

The ast-grep rules are ported from jev-lint's `src/testcalls.ts`. Do not simplify them; each alternative in the callee regexes is a framework spelling that a narrower matcher silently misses, and a matcher that misses is invisible.

**Files:**
- Create: `src/extract.ts`
- Test: `test/extract.test.ts`

- [ ] **Step 1: Write the failing test**

`test/extract.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTests } from "../src/extract.ts";

const VITEST = `
import { describe, it, test } from "vitest";
describe("Cart", () => {
  describe("applyDiscount", () => {
    it("clamps at zero", () => {});
    it.skip("rounds half up", () => {});
  });
  test("totals", async () => {});
});
test("top level", () => {});
`;

test("extractTests reports the suite chain outermost first", () => {
  const found = extractTests(VITEST, "src/cart.test.ts", "vitest");
  const names = found.map((t) => t.titlePath.join(" > "));
  assert.deepEqual(names, [
    "Cart > applyDiscount > clamps at zero",
    "Cart > applyDiscount > rounds half up",
    "Cart > totals",
    "top level",
  ]);
});

test("extractTests carries the framework, the file and 1-based lines", () => {
  const found = extractTests(VITEST, "src/cart.test.ts", "vitest");
  const first = found[0]!;
  assert.equal(first.file, "src/cart.test.ts");
  assert.equal(first.framework, "vitest");
  assert.equal(first.line, 5);
  assert.equal(first.dynamic, false);
});

test("extractTests marks an interpolated title dynamic and keeps it", () => {
  const src = "import { it } from 'vitest';\nit(`case ${n}`, () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.dynamic, true);
});

test("extractTests marks an .each row dynamic", () => {
  const src = "import { it } from 'vitest';\nit.each([1,2])('adds %i', () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.dynamic, true);
});

test("extractTests skips a todo with no body", () => {
  const src = "import { it } from 'vitest';\nit.todo('later');\nit('now', () => {});";
  const names = extractTests(src, "a.test.ts", "vitest").map((t) => t.titlePath.join(" > "));
  assert.deepEqual(names, ["now"]);
});

test("extractTests reads node:test subtests as a suite", () => {
  const src = `
import test from "node:test";
test("applyDiscount", async (t) => {
  await t.test("clamps", () => {});
});
`;
  const names = extractTests(src, "a.test.ts", "node").map((t) => t.titlePath.join(" | "));
  assert.deepEqual(names, ["applyDiscount | clamps"]);
});

test("extractTests reads Playwright's test.describe", () => {
  const src = `
import { test } from "@playwright/test";
test.describe("Login", () => {
  test("succeeds", async () => {});
});
`;
  const found = extractTests(src, "e2e/a.spec.ts", "playwright");
  assert.deepEqual(found.map((t) => t.titlePath), [["Login", "succeeds"]]);
  assert.equal(found[0]!.line, 4);
});

test("extractTests unescapes a quoted title", () => {
  const src = "import { it } from 'vitest';\nit('it\\'s fine', () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.deepEqual(found[0]!.titlePath, ["it's fine"]);
});

test("extractTests parses tsx", () => {
  const src = "import { it } from 'vitest';\nit('renders', () => { const x = <div/>; });";
  const found = extractTests(src, "a.test.tsx", "vitest");
  assert.deepEqual(found[0]!.titlePath, ["renders"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/extract.test.ts`
Expected: FAIL, `Cannot find module '../src/extract.ts'`.

- [ ] **Step 3: Write the implementation**

`src/extract.ts`:

```ts
/**
 * The test inventory, read out of the source.
 *
 * The matchers are jev-lint's, which were written once for every ECMAScript
 * test framework rather than per framework: `test("x", { timeout }, fn)` from
 * node:test, `test.describe` from Playwright, `Deno.test({ name, fn })` and
 * `test.if(cond)("x", fn)` from bun are all shapes a jest-shaped matcher
 * misses, and a matcher that misses produces no error -- only a test that
 * quietly never runs.
 */
import { parse } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import { langFor } from "./framework.ts";
import type { Framework, TestCase } from "./types.ts";

/** `describe(...)` and its spellings; Playwright's `test.describe` with its own modifiers. */
const SUITE_CALLEE =
  "^(x|f)?(describe|suite|context)(\\.(only|skip|todo|concurrent|sequential|shuffle|skipIf|runIf|if|each|for)(\\([^)]*\\))?)*$" +
  "|^test\\.describe(\\.(serial|parallel|only|skip|fixme|configure)(\\([^)]*\\))?)*$";

/** The names node:test's context goes by, for `t.test("subtest", fn)`. */
const SUBTEST_CONTEXT = "(t|ctx|context)";

/** A subtest call, wherever it sits inside the parent. */
const SUBTEST_INSIDE = {
  stopBy: "end",
  kind: "call_expression",
  has: { field: "function", regex: `^${SUBTEST_CONTEXT}\\.test$` },
};

/** `it`/`test` with modifiers; `Deno.test`; node:test's subtest on the context. */
const TEST_CALLEE =
  "^(x|f)?(it|test)(\\.(only|skip|todo|concurrent|sequential|fails|fixme|slow|skipIf|runIf|if|todoIf|failsIf|each|for)(\\([^)]*\\))?)*$" +
  "|^Deno\\.test(\\.(only|ignore))?$" +
  `|^${SUBTEST_CONTEXT}\\.test$`;

const FUNCTION_KINDS = [{ kind: "arrow_function" }, { kind: "function_expression" }, { kind: "generator_function" }];

/** The title, by whichever of the three shapes carries it. */
const TITLE_ARG = {
  field: "arguments",
  any: [
    { has: { nthChild: 1, any: [{ kind: "string" }, { kind: "template_string" }], pattern: "$TITLE" } },
    {
      has: {
        nthChild: 1,
        kind: "object",
        has: {
          kind: "pair",
          all: [{ has: { field: "key", regex: "^name$" } }, { has: { field: "value", pattern: "$TITLE" } }],
        },
      },
    },
    { has: { nthChild: 1, kind: "function_expression", has: { field: "name", pattern: "$TITLE" } } },
  ],
};

/**
 * A test call: a test callee, a title, a body to run, and -- for node:test --
 * no subtests inside it, because a parent that only opens subtests is their
 * suite and is matched as one below.
 */
const TEST_RULE = {
  kind: "call_expression",
  all: [
    { has: { field: "function", regex: TEST_CALLEE } },
    { has: TITLE_ARG },
    { not: { has: SUBTEST_INSIDE } },
    {
      has: {
        field: "arguments",
        any: [
          { has: { any: FUNCTION_KINDS, pattern: "$BODY" } },
          {
            has: {
              kind: "object",
              has: { any: [{ kind: "method_definition" }, { kind: "pair", has: { any: FUNCTION_KINDS } }], pattern: "$BODY" },
            },
          },
        ],
      },
    },
  ],
};

/** A suite call, or a node:test parent that holds subtests. */
const SUITE_RULE = {
  kind: "call_expression",
  all: [
    {
      any: [
        { has: { field: "function", regex: SUITE_CALLEE } },
        { all: [{ has: { field: "function", regex: TEST_CALLEE } }, { has: SUBTEST_INSIDE }] },
      ],
    },
    { has: { field: "arguments", has: { nthChild: 1, any: [{ kind: "string" }, { kind: "template_string" }], pattern: "$TITLE" } } },
    { has: { field: "arguments", has: { any: FUNCTION_KINDS, pattern: "$BODY" } } },
  ],
};

/**
 * The text of a string literal, or null when the title is not statically
 * knowable -- a template with an interpolation. A caller that gets null must
 * treat the test as dynamic rather than drop it.
 */
export function literalTitle(raw: string): string | null {
  const q = raw[0];
  if (q !== "'" && q !== '"' && q !== "`") return null;
  const body = raw.slice(1, -1);
  if (q === "`" && /\$\{/.test(body)) return null;
  return body.replace(/\\(.)/g, "$1");
}

/** `.each(...)` / `.for(...)` generate one test per row, so no static title names them. */
const GENERATED = /\.(each|for)\b/;

interface Found {
  start: number;
  end: number;
  node: SgNode;
  title: string | null;
}

function collect(root: SgNode, rule: unknown): Found[] {
  return root.findAll({ rule: rule as never }).map((node) => {
    const range = node.range();
    const raw = node.getMatch("TITLE")?.text() ?? null;
    return {
      start: range.start.index,
      end: range.end.index,
      node,
      title: raw === null ? null : literalTitle(raw),
    };
  });
}

/**
 * Every test in one file.
 *
 * The suite chain is taken by range containment rather than by walking
 * ancestors, so a suite shape the ancestor walk would not recognise still
 * contributes its title as long as the suite matcher found it.
 */
export function extractTests(source: string, file: string, framework: Framework): TestCase[] {
  const root = parse(langFor(file), source).root();
  const tests = collect(root, TEST_RULE);
  const suites = collect(root, SUITE_RULE);

  return tests.map((t) => {
    const chain = suites
      .filter((s) => s.start <= t.start && s.end >= t.end && !(s.start === t.start && s.end === t.end))
      .sort((a, b) => a.start - b.start || b.end - a.end);

    const parts = [...chain, t];
    const dynamic = parts.some((p) => p.title === null) || GENERATED.test(calleeText(t.node));
    const range = t.node.range();
    return {
      file,
      titlePath: parts.map((p) => p.title ?? ""),
      line: range.start.line + 1,
      endLine: range.end.line + 1,
      framework,
      dynamic,
    };
  });
}

function calleeText(node: SgNode): string {
  return node.field("function")?.text() ?? "";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/extract.test.ts`
Expected: PASS, `pass 9`. If the Playwright case reports the wrong line, print `node.range()` for that match before changing the rule — the rule is ported and known good.

- [ ] **Step 5: Commit**

```bash
git add src/extract.ts test/extract.test.ts
git commit -m "feat: extract the test inventory with ast-grep"
```

---

## Task 6: The gate (`src/gate.ts`)

**Files:**
- Create: `src/gate.ts`
- Test: `test/gate.test.ts`

- [ ] **Step 1: Write the failing test**

`test/gate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, DEFAULT_CUTOFF } from "../src/gate.ts";
import { testId } from "../src/types.ts";
import type { Answer, TestCase } from "../src/types.ts";

function mk(name: string, over: Partial<TestCase> = {}): TestCase {
  return { file: "a.test.ts", titlePath: [name], line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function answers(...values: Array<Answer | null>): Map<string, Answer | null> {
  const m = new Map<string, Answer | null>();
  values.forEach((a, i) => m.set(`q${String(i).padStart(4, "0")}`, a));
  return m;
}

test("a score at the cutoff is selected and one under it is not", () => {
  const tests = [mk("hot"), mk("cold")];
  const sel = gate(tests, answers({ value: DEFAULT_CUTOFF, confidence: 0.9 }, { value: 1.4, confidence: 0.9 }), new Set());
  assert.deepEqual(sel.verdicts.map((v) => v.selected), [true, false]);
  assert.deepEqual(sel.verdicts.map((v) => v.reason), ["scored", "below"]);
});

test("an unsure answer near the cutoff is selected to be safe", () => {
  const sel = gate([mk("maybe")], answers({ value: 1.2, confidence: 0.3 }), new Set());
  assert.equal(sel.verdicts[0]!.selected, true);
  assert.equal(sel.verdicts[0]!.reason, "unsure");
});

test("an unsure answer far under the cutoff is still not selected", () => {
  const sel = gate([mk("cold")], answers({ value: 0.2, confidence: 0.1 }), new Set());
  assert.equal(sel.verdicts[0]!.selected, false);
});

test("a confident answer under the cutoff is not rescued", () => {
  const sel = gate([mk("cold")], answers({ value: 1.2, confidence: 0.95 }), new Set());
  assert.equal(sel.verdicts[0]!.selected, false);
});

test("a missing answer is selected, not treated as a pass", () => {
  const sel = gate([mk("lost")], answers(null), new Set());
  assert.equal(sel.verdicts[0]!.selected, true);
  assert.equal(sel.verdicts[0]!.reason, "missing");
});

test("a touched test is selected without consulting its answer", () => {
  const t = mk("edited");
  const sel = gate([t], answers({ value: 0, confidence: 0.99 }), new Set([testId(t)]));
  assert.equal(sel.verdicts[0]!.selected, true);
  assert.equal(sel.verdicts[0]!.reason, "touched");
});

test("a dynamic test is always selected", () => {
  const sel = gate([mk("each", { dynamic: true })], answers({ value: 0, confidence: 0.99 }), new Set());
  assert.equal(sel.verdicts[0]!.reason, "dynamic");
  assert.equal(sel.verdicts[0]!.selected, true);
});

test("the cutoff is overridable and changes nothing else", () => {
  const sel = gate([mk("mild")], answers({ value: 1.5, confidence: 0.9 }), new Set(), { cutoff: 1.0 });
  assert.equal(sel.verdicts[0]!.selected, true);
  assert.equal(sel.verdicts[0]!.reason, "scored");
});

test("selected mirrors the verdicts and fallback starts null", () => {
  const tests = [mk("a"), mk("b")];
  const sel = gate(tests, answers({ value: 3, confidence: 0.9 }, { value: 0, confidence: 0.9 }), new Set());
  assert.deepEqual(sel.selected.map((t) => t.titlePath[0]), ["a"]);
  assert.equal(sel.all.length, 2);
  assert.equal(sel.fallback, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/gate.test.ts`
Expected: FAIL, `Cannot find module '../src/gate.ts'`.

- [ ] **Step 3: Write the implementation**

`src/gate.ts`:

```ts
/**
 * Answers in, a selection out.
 *
 * Everything here is pure and runs offline, and that separation is the point:
 * verdicts are what cost money and thresholds are what you will change twenty
 * times, so re-gating a recorded run has to be free. That is what `--replay`
 * is.
 *
 * Two rules, each of them the same one under different names:
 *
 * 1. **Confidence routes, it does not gate.** A verdict under the cutoff that
 *    the model was unsure about is selected, because running a test that did
 *    not need to run costs seconds and skipping one that did costs a release.
 * 2. **No answer is not a passing grade.** A missing or malformed answer
 *    selects the test, so a run whose requests failed cannot read as a small
 *    selection.
 */
import { questionId } from "./questions.ts";
import { testId } from "./types.ts";
import type { Answer, Selection, TestCase, Verdict } from "./types.ts";

/**
 * The boundary between "this change cannot alter the outcome" (level 1) and
 * "it might" (level 2). It is a level boundary, not a tuned number, and it is
 * the one default worth defending.
 */
export const DEFAULT_CUTOFF = 2.0;

/** Under this, the model's own ranking is not worth acting on. */
export const DEFAULT_UNSURE_BELOW = 0.5;

/** How far under the cutoff an unsure answer is still rescued. */
export const DEFAULT_UNSURE_MARGIN = 1.0;

export interface GateOptions {
  cutoff?: number;
  unsureBelow?: number;
  unsureMargin?: number;
}

/** Decide one test. Never returns null: every test gets a side and a reason. */
export function decide(
  id: string,
  t: TestCase,
  answer: Answer | null,
  touched: boolean,
  { cutoff = DEFAULT_CUTOFF, unsureBelow = DEFAULT_UNSURE_BELOW, unsureMargin = DEFAULT_UNSURE_MARGIN }: GateOptions = {},
): Verdict {
  if (touched) return { id, test: t, answer, reason: "touched", selected: true };
  if (t.dynamic) return { id, test: t, answer, reason: "dynamic", selected: true };
  if (!answer) return { id, test: t, answer: null, reason: "missing", selected: true };
  if (answer.value >= cutoff) return { id, test: t, answer, reason: "scored", selected: true };
  if (answer.confidence !== null && answer.confidence < unsureBelow && answer.value >= cutoff - unsureMargin) {
    return { id, test: t, answer, reason: "unsure", selected: true };
  }
  return { id, test: t, answer, reason: "below", selected: false };
}

/**
 * Decide every test.
 *
 * `answers` is keyed by question id, which is the test's index in `tests`;
 * `touched` is keyed by `testId`, because it is computed from the diff before
 * any question exists.
 */
export function gate(
  tests: TestCase[],
  answers: Map<string, Answer | null>,
  touched: Set<string>,
  opts: GateOptions = {},
): Selection {
  const verdicts = tests.map((t, i) => {
    const id = questionId(i);
    return decide(id, t, answers.get(id) ?? null, touched.has(testId(t)), opts);
  });
  return {
    verdicts,
    selected: verdicts.filter((v) => v.selected).map((v) => v.test),
    all: tests,
    fallback: null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/gate.test.ts`
Expected: FAIL first with `Cannot find module './questions.ts'`. Write Task 7 before re-running, or temporarily inline `questionId`; the plan orders them this way because the gate's tests define the id convention that Task 7 must satisfy.

- [ ] **Step 5: Commit after Task 7 passes**

Hold this commit until `node --test test/gate.test.ts` reports `pass 9`, then:

```bash
git add src/gate.ts test/gate.test.ts
git commit -m "feat: turn answers into a selection, with the only thresholds in the program"
```

---

## Task 7: Questions and answers (`src/questions.ts`)

**Files:**
- Create: `src/questions.ts`
- Test: `test/questions.test.ts`

- [ ] **Step 1: Write the failing test**

`test/questions.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuestion, questionId, readAnswer, SCORE_LEVELS } from "../src/questions.ts";
import type { TestCase } from "../src/types.ts";

const t: TestCase = {
  file: "src/cart.test.ts",
  titlePath: ["Cart", "applyDiscount", "clamps at zero"],
  line: 12,
  endLine: 18,
  framework: "vitest",
  dynamic: false,
};

test("questionId is zero padded and ordered", () => {
  assert.equal(questionId(0), "q0000");
  assert.equal(questionId(7), "q0007");
  assert.ok(questionId(9) < questionId(10));
});

test("buildQuestion is a score question with the four levels", () => {
  const q = buildQuestion(t, "q0007");
  assert.equal(q.type, "score");
  assert.deepEqual(q.criteria, SCORE_LEVELS);
});

test("buildQuestion names the file and the joined test name", () => {
  const q = buildQuestion(t, "q0007");
  assert.equal(q.instructions.test_file, "src/cart.test.ts");
  assert.equal(q.instructions.test_name, "Cart > applyDiscount > clamps at zero");
  assert.equal(q.instructions.subject, "q0007");
});

test("buildQuestion carries no threshold", () => {
  const text = JSON.stringify(buildQuestion(t, "q0000"));
  assert.equal(/cutoff|threshold|at least/i.test(text), false);
});

test("readAnswer takes a score and its confidence", () => {
  assert.deepEqual(readAnswer({ score: 2, confidence: 0.8 }), { value: 2, confidence: 0.8 });
});

test("readAnswer accepts the value spelling", () => {
  assert.deepEqual(readAnswer({ value: 3, confidence: 0.4 }), { value: 3, confidence: 0.4 });
});

test("readAnswer returns null for anything unusable", () => {
  assert.equal(readAnswer(null), null);
  assert.equal(readAnswer({}), null);
  assert.equal(readAnswer({ score: "two" }), null);
  assert.equal(readAnswer({ score: Number.NaN }), null);
});

test("readAnswer tolerates a missing confidence", () => {
  assert.deepEqual(readAnswer({ score: 1 }), { value: 1, confidence: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/questions.test.ts`
Expected: FAIL, `Cannot find module '../src/questions.ts'`.

- [ ] **Step 3: Write the implementation**

`src/questions.ts`:

```ts
/**
 * One question per test.
 *
 * `score` rather than `choice` because the answer is an ordered conclusion:
 * asking "how much can this change break this test" as an unordered choice
 * discards the ordering, splits the probability mass between adjacent levels,
 * and returns a low confidence that is indistinguishable from real
 * uncertainty.
 *
 * No threshold ever appears in a question. The cutoff is a decision the gate
 * makes from the answer; writing it into the question would mean every
 * recalibration rewrote the question, and no run could be compared with an
 * earlier one.
 */
import type { TestCase } from "./types.ts";

export interface ScoreQuestion {
  type: "score";
  instructions: Record<string, unknown>;
  criteria: readonly string[];
}

const TASK =
  "The state is a git diff. Judge only the one test identified below, and only " +
  "for whether this change can alter its outcome -- other problems with the test " +
  "or with the change are not your concern here.";

export const SCORE_LEVELS = [
  "Unrelated to this change: running this test cannot produce a different result than before.",
  "This test exercises code the change touched, but nothing in the change can alter its outcome.",
  "This test could be affected by the change: it might fail.",
  "This test directly exercises behaviour the change altered or broke: it is likely to fail.",
] as const;

export const SCORE_LEVEL_NAMES = ["unrelated", "unaffected", "at-risk", "likely-failing"] as const;

/** Stable question name, so answers can be matched back by the test's index. */
export function questionId(i: number): string {
  return `q${String(i).padStart(4, "0")}`;
}

/**
 * The name the test is asked about is the runner's own spelling of it, so a
 * reader of `--json` can paste it into `-t` and see the same test. Playwright
 * is selected by location rather than by name, so its chain is joined the way
 * its reporter prints it.
 */
export function displayName(t: TestCase): string {
  const sep = t.framework === "node" ? " " : " > ";
  return t.titlePath.join(sep);
}

export function buildQuestion(t: TestCase, id: string): ScoreQuestion {
  return {
    type: "score",
    instructions: {
      task: TASK,
      subject: id,
      test_file: t.file,
      test_name: displayName(t),
      test_lines: t.line === t.endLine ? `${t.line}` : `${t.line}-${t.endLine}`,
    },
    criteria: SCORE_LEVELS,
  };
}

/**
 * One answer, or null when it cannot be used.
 *
 * Null rather than zero: a malformed answer must select the test, and a zero
 * would silently deselect it.
 */
export function readAnswer(raw: unknown): { value: number; confidence: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const v = typeof o.score === "number" ? o.score : typeof o.value === "number" ? o.value : null;
  if (v === null || !Number.isFinite(v)) return null;
  const c = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : null;
  return { value: v, confidence: c };
}
```

- [ ] **Step 4: Run both test files to verify they pass**

Run: `node --test test/questions.test.ts test/gate.test.ts`
Expected: PASS, `pass 17` in total.

- [ ] **Step 5: Commit both**

```bash
git add src/questions.ts src/gate.ts test/questions.test.ts test/gate.test.ts
git commit -m "feat: ask one score question per test and gate the answers"
```

---

## Task 8: Filter rendering (`src/filter.ts`)

The strongest test here is the round trip: build the pattern, then apply it as a real `RegExp` to every extracted name and assert that it matches exactly the selected ones. A pattern bug is otherwise invisible — the run simply skips tests.

**Files:**
- Create: `src/filter.ts`
- Test: `test/filter.test.ts`

- [ ] **Step 1: Write the failing test**

`test/filter.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter, escapeRegExp, fullName } from "../src/filter.ts";
import type { Selection, TestCase } from "../src/types.ts";

function mk(file: string, path: string[], over: Partial<TestCase> = {}): TestCase {
  return { file, titlePath: path, line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function sel(all: TestCase[], selected: TestCase[]): Selection {
  return {
    all,
    selected,
    verdicts: all.map((t, i) => ({
      id: `q${i}`,
      test: t,
      answer: null,
      reason: selected.includes(t) ? "scored" : "below",
      selected: selected.includes(t),
    })),
    fallback: null,
  };
}

test("fullName joins with ' > ' for vitest and ' ' for node", () => {
  assert.equal(fullName(mk("a.test.ts", ["A", "b"])), "A > b");
  assert.equal(fullName(mk("a.test.ts", ["A", "b"], { framework: "node" })), "A b");
});

test("escapeRegExp neutralises every metacharacter", () => {
  const raw = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
  assert.equal(new RegExp(`^${escapeRegExp(raw)}$`).test(raw), true);
});

test("vitest gets the files and one anchored alternation", () => {
  const a = mk("x.test.ts", ["Cart", "totals"]);
  const b = mk("x.test.ts", ["Cart", "empties"]);
  const c = mk("y.test.ts", ["Tax", "rounds"]);
  const f = buildFilter(sel([a, b, c], [a, c]), "vitest");
  assert.equal(f.mode, "pattern");
  assert.deepEqual(f.argv, ["-t", "^(?:Cart > totals|Tax > rounds)$", "x.test.ts", "y.test.ts"]);
});

test("the generated pattern matches exactly the selected names", () => {
  const all = [
    mk("x.test.ts", ["Cart", "totals"]),
    mk("x.test.ts", ["Cart", "totals (v2)"]),
    mk("x.test.ts", ["Cart", "totals nothing"]),
    mk("y.test.ts", ["Tax", "rounds"]),
  ];
  const selected = [all[0]!, all[1]!];
  const f = buildFilter(sel(all, selected), "vitest");
  const re = new RegExp(f.argv[1]!);
  for (const t of all) {
    assert.equal(re.test(fullName(t)), selected.includes(t), `pattern is wrong for ${fullName(t)}`);
  }
});

test("node:test gets a single --test-name-pattern with the space spelling", () => {
  const a = mk("x.test.ts", ["Cart", "totals"], { framework: "node" });
  const b = mk("x.test.ts", ["Cart", "empties"], { framework: "node" });
  const f = buildFilter(sel([a, b], [a]), "node");
  assert.equal(f.mode, "pattern");
  assert.deepEqual(f.argv, ["--test-name-pattern", "^(?:Cart totals)$", "x.test.ts"]);
  assert.equal(f.argv.filter((s) => s === "--test-name-pattern").length, 1);
});

test("the name pattern precedes the files, because node ignores it otherwise", () => {
  const a = mk("x.test.ts", ["Cart", "totals"], { framework: "node" });
  const b = mk("x.test.ts", ["Cart", "empties"], { framework: "node" });
  const f = buildFilter(sel([a, b], [a]), "node");
  assert.equal(f.argv[0], "--test-name-pattern");
  assert.equal(f.argv.at(-1), "x.test.ts");
});

test("playwright is selected by file and line", () => {
  const a = mk("e2e/a.spec.ts", ["Login", "succeeds"], { framework: "playwright", line: 4 });
  const b = mk("e2e/a.spec.ts", ["Login", "fails"], { framework: "playwright", line: 9 });
  const c = mk("e2e/b.spec.ts", ["Signup", "succeeds"], { framework: "playwright", line: 3 });
  const f = buildFilter(sel([a, b, c], [a, c]), "playwright");
  assert.equal(f.mode, "locations");
  assert.deepEqual(f.argv, ["e2e/a.spec.ts:4", "e2e/b.spec.ts:3"]);
});

test("selecting every playwright test means no arguments, not a list of locations", () => {
  const a = mk("e2e/a.spec.ts", ["Login", "succeeds"], { framework: "playwright", line: 4 });
  const b = mk("e2e/a.spec.ts", ["Login", "fails"], { framework: "playwright", line: 9 });
  const f = buildFilter(sel([a, b], [a, b]), "playwright");
  assert.equal(f.mode, "all");
  assert.deepEqual(f.argv, []);
});

test("selecting everything means no arguments at all", () => {
  const a = mk("x.test.ts", ["a"]);
  const f = buildFilter(sel([a], [a]), "vitest");
  assert.equal(f.mode, "all");
  assert.deepEqual(f.argv, []);
});

test("selecting nothing is its own mode", () => {
  const a = mk("x.test.ts", ["a"]);
  const f = buildFilter(sel([a], []), "vitest");
  assert.equal(f.mode, "none");
  assert.deepEqual(f.argv, []);
});

test("a dynamic test in the selection degrades to file-level filtering", () => {
  const a = mk("x.test.ts", ["Cart", "row"], { dynamic: true });
  const b = mk("y.test.ts", ["Tax", "rounds"]);
  const c = mk("z.test.ts", ["Old", "thing"]);
  const f = buildFilter(sel([a, b, c], [a, b]), "vitest");
  assert.equal(f.mode, "files");
  assert.deepEqual(f.argv, ["x.test.ts", "y.test.ts"]);
});

test("a high selection rate degrades to file-level filtering", () => {
  const all = Array.from({ length: 10 }, (_, i) => mk(`f${i}.test.ts`, [`t${i}`]));
  const f = buildFilter(sel(all, all.slice(0, 9)), "vitest", { fileThreshold: 0.8 });
  assert.equal(f.mode, "files");
  assert.equal(f.argv.length, 9);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/filter.test.ts`
Expected: FAIL, `Cannot find module '../src/filter.ts'`.

- [ ] **Step 3: Write the implementation**

`src/filter.ts`:

```ts
/**
 * A selection, as the runner's own arguments.
 *
 * Three shapes, one per framework family, and the differences between them
 * were measured rather than assumed:
 *
 *   - Vitest joins a full name with `" > "`; node:test joins it with a single
 *     space. A pattern in the wrong spelling selects nothing and says nothing.
 *   - node:test ORs repeated `--test-name-pattern` flags, and a pattern that
 *     matches a SUITE name runs every test under it. One flag, one
 *     alternation of anchored full names, is the only safe shape.
 *   - Playwright's `--grep` matches `"<project> <file> <chain> <title>"`, so an
 *     anchored pattern would have to know the project name and would break
 *     when a project is added. `file:line` is exact and needs no escaping.
 */
import type { Framework, Selection, TestCase } from "./types.ts";

export type FilterMode =
  /** Everything was selected: pass no arguments and let the runner run. */
  | "all"
  /** Nothing was selected: there is nothing to run. */
  | "none"
  /** Whole files, because a name pattern cannot express the selection. */
  | "files"
  /** Files plus an anchored alternation of full names. */
  | "pattern"
  /** `file:line` positionals. */
  | "locations";

export interface FilterArgs {
  mode: FilterMode;
  /** Arguments to append to the runner command, in order. */
  argv: string[];
}

export interface FilterOptions {
  /**
   * Above this fraction of the suite, the name pattern is dropped and whole
   * files are selected instead. A run that keeps most of the suite gains
   * nothing from an alternation of a thousand names.
   */
  fileThreshold?: number;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The full name as this test's own runner spells it. */
export function fullName(t: TestCase): string {
  const sep = t.framework === "node" ? " " : " > ";
  return t.titlePath.join(sep);
}

/** The flag that carries a name pattern, per framework. */
function patternFlag(framework: Framework): string | null {
  if (framework === "node") return "--test-name-pattern";
  if (framework === "vitest" || framework === "jest") return "-t";
  return null;
}

function uniqueFiles(tests: TestCase[]): string[] {
  return [...new Set(tests.map((t) => t.file))];
}

export function buildFilter(sel: Selection, framework: Framework, { fileThreshold = 0.8 }: FilterOptions = {}): FilterArgs {
  const { selected, all } = sel;
  // Both of these come before the per-framework dispatch on purpose. When
  // every test is selected, no arguments is not merely shorter than naming
  // them all -- it is the same run, and for Playwright it is the difference
  // between one command and one argument per test. When none is selected
  // there is nothing any framework could be asked to run.
  if (selected.length === 0) return { mode: "none", argv: [] };
  if (selected.length === all.length) return { mode: "all", argv: [] };

  if (framework === "playwright") {
    return { mode: "locations", argv: selected.map((t) => `${t.file}:${t.line}`) };
  }

  const files = uniqueFiles(selected);
  const flag = patternFlag(framework);
  // A dynamic test has no name a pattern can hold, and a pattern applies to
  // the whole run rather than to one file -- so one of them costs the run its
  // name-level filtering. Files are still a large saving.
  const hasDynamic = selected.some((t) => t.dynamic);
  const rate = selected.length / all.length;
  if (!flag || hasDynamic || rate > fileThreshold) {
    return { mode: "files", argv: files };
  }

  const names = [...new Set(selected.map(fullName))];
  const pattern = `^(?:${names.map(escapeRegExp).join("|")})$`;
  // The flag goes BEFORE the files, and that is not a style choice. Node's
  // test runner silently ignores `--test-name-pattern` when it follows a
  // positional: `node --test a.test.js --test-name-pattern X` runs the whole
  // file and exits 0. Vitest accepts either order, so one order serves both.
  return { mode: "pattern", argv: [flag, pattern, ...files] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/filter.test.ts`
Expected: PASS, `pass 12`.

- [ ] **Step 5: Commit**

```bash
git add src/filter.ts test/filter.test.ts
git commit -m "feat: render a selection as per-framework runner arguments"
```

---

## Task 9: The Jev client (`src/jev.ts`)

Ported from `~/ghq/github.com/mizchi/jevlint/src/jev.ts`. Read that file and carry over `Pacer`, `Jev`, `JevError`, `mapLimit` and the comments that explain the measured constants. The changes below are the only intentional ones.

**Files:**
- Create: `src/jev.ts`
- Test: `test/jev.test.ts`

- [ ] **Step 1: Write the failing test**

`test/jev.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Jev, JevError, Pacer, mapLimit } from "../src/jev.ts";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

test("ask posts one state and many questions to /v1/systemone", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const jev = new Jev({
    apiKey: "k",
    pacer: new Pacer(1e9, 1e9),
    fetch: async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      return ok({ answers: { q0000: { score: 2, confidence: 0.8 } }, usage: { input_tokens: 10 } });
    },
  });
  const res = await jev.ask({ diff: "x" }, { q0000: { type: "score", instructions: {}, criteria: ["a"] } });
  assert.match(seen[0]!.url, /\/v1\/systemone$/);
  assert.deepEqual((seen[0]!.body as Record<string, unknown>).state, { diff: "x" });
  assert.deepEqual(res.answers, { q0000: { score: 2, confidence: 0.8 } });
  assert.equal(jev.spent.inputTokens, 10);
});

test("ask with no questions makes no request", async () => {
  let calls = 0;
  const jev = new Jev({ apiKey: "k", fetch: async () => { calls += 1; return ok({}); } });
  const res = await jev.ask({}, {});
  assert.equal(calls, 0);
  assert.deepEqual(res.answers, {});
});

test("askSplitting halves the questions on max_tokens_exceeded", async () => {
  const sizes: number[] = [];
  const jev = new Jev({
    apiKey: "k",
    pacer: new Pacer(1e9, 1e9),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
      const n = Object.keys(body.questions).length;
      sizes.push(n);
      if (n > 2) return new Response('{"error":"max_tokens_exceeded"}', { status: 400 });
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { score: 1, confidence: 0.5 }]));
      return ok({ answers, usage: { input_tokens: n } });
    },
  });
  const questions = Object.fromEntries(
    Array.from({ length: 4 }, (_, i) => [`q${i}`, { type: "score", instructions: {}, criteria: ["a"] }]),
  );
  const res = await jev.askSplitting({}, questions as never);
  assert.deepEqual(Object.keys(res.answers!).sort(), ["q0", "q1", "q2", "q3"]);
  assert.deepEqual(sizes, [4, 2, 2]);
});

test("a 401 is an auth error and is not retried", async () => {
  let calls = 0;
  const jev = new Jev({
    apiKey: "k",
    retries: 3,
    pacer: new Pacer(1e9, 1e9),
    fetch: async () => { calls += 1; return new Response("nope", { status: 401 }); },
  });
  await assert.rejects(
    () => jev.ask({}, { q0: { type: "score", instructions: {}, criteria: ["a"] } }),
    (err: unknown) => err instanceof JevError && err.kind === "auth",
  );
  assert.equal(calls, 1);
});

test("a missing key fails before any request", async () => {
  const jev = new Jev({ apiKey: "", fetch: async () => { throw new Error("should not be called"); } });
  await assert.rejects(
    () => jev.ask({}, { q0: { type: "score", instructions: {}, criteria: ["a"] } }),
    /TYPESAFE_API_KEY/,
  );
});

test("Pacer waits until the bucket can pay and settles to the real count", () => {
  const p = new Pacer(1000, 1000, 0);
  assert.equal(p.delay(500, 0), 0);
  p.take(500);
  assert.equal(p.delay(1000, 0) > 0, true);
  p.settle(500, 100);
  assert.equal(p.available(0), 900);
});

test("Pacer treats a backwards clock as no elapsed time", () => {
  const p = new Pacer(1000, 1000, 1_000_000);
  assert.equal(p.available(999_000), 1000);
});

test("mapLimit preserves input order", async () => {
  const out = await mapLimit([3, 1, 2], 2, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n * 10;
  });
  assert.deepEqual(out, [30, 10, 20]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/jev.test.ts`
Expected: FAIL, `Cannot find module '../src/jev.ts'`.

- [ ] **Step 3: Port the client**

Copy `~/ghq/github.com/mizchi/jevlint/src/jev.ts` to `src/jev.ts` and apply exactly these changes:

1. Replace the `estimateTokens` import from `./batch.ts` with a local estimator, since this package has no batch planner:

```ts
/**
 * A rough input-token count for the pacer's mirror of the server's bucket.
 *
 * Deliberately approximate: the pacer corrects itself to the server's own
 * count when the answer comes back, and `askSplitting` reacts to the server's
 * `max_tokens_exceeded` rather than predicting it, so an estimate that is
 * wrong by a third costs nothing.
 */
export function estimateTokens(body: unknown): number {
  return Math.ceil(JSON.stringify(body).length / 3.6);
}
```

and call it as `estimateTokens({ model: this.model, state, questions })`.

2. Replace the `Question`, `Spend` and `SystemOneResponse` imports from `./types.ts` with a local declaration in `src/jev.ts`:

```ts
import type { ScoreQuestion } from "./questions.ts";

export type Question = ScoreQuestion;

export interface SystemOneResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface Spend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  retried: number;
  rateLimited: number;
  tokensPerSecond: number;
  splits: number;
  usd: number;
}
```

3. Rename the two pacer environment overrides from `JEV_LINT_TOKENS_PER_SECOND` / `JEV_LINT_TOKEN_BURST` to `JEV_TEST_FILTER_TOKENS_PER_SECOND` / `JEV_TEST_FILTER_TOKEN_BURST`, and `JEV_LINT_MODEL` to `JEV_TEST_FILTER_MODEL`. Leave `TYPESAFE_API_KEY`, `TYPESAFEAI_API_KEY`, `TYPESAFE_BASE_URL` and `TYPESAFEAI_BASE_URL` alone — those are the account's, not this tool's.

4. Keep `DEFAULT_CONCURRENCY`, `DEFAULT_TOKENS_PER_SECOND`, `DEFAULT_TOKEN_BURST`, `USD_PER_MTOK` and every comment that explains how they were measured. They are the record of a measurement this package cannot repeat.

5. Fix a latent bug in `Pacer#refill`: it assumes the clock only moves forward. Clamp the elapsed time at zero.

```ts
  private refill(now: number): void {
    // A clock that goes backwards -- an NTP step, a suspended laptop waking --
    // must not DRAIN the mirror. Unclamped, a one-second backwards jump takes
    // a second's worth of refill out of the bucket, and the client then waits
    // for a limit the server is not imposing. Treat it as no elapsed time.
    const elapsed = Math.max(0, now - this.at);
    this.level = Math.min(this.burst, this.level + (elapsed / 1000) * this.rate);
    this.at = now;
  }
```

This is a divergence from jev-lint, not a port artefact. It is worth reporting upstream.

6. Fix the one place `noUncheckedIndexedAccess` rejects. In `askSplitting`:

```ts
        // `part` is a slice of this object's own keys, so the lookup cannot miss.
        const subset = Object.fromEntries(part.map((n) => [n, questions[n]!]));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/jev.test.ts`
Expected: PASS, `pass 8`.

- [ ] **Step 5: Commit**

```bash
git add src/jev.ts test/jev.test.ts
git commit -m "feat: port the Jev client from jev-lint"
```

---

## Task 10: The state (`src/state.ts`)

**Files:**
- Create: `src/state.ts`
- Test: `test/state.test.ts`

- [ ] **Step 1: Write the failing test**

`test/state.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildState } from "../src/state.ts";

function section(file: string, filler: number): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,0 +1,1 @@",
    `+${"x".repeat(filler)}`,
  ].join("\n");
}

const STAT = " src/big.ts   | 400 ++++\n src/small.ts |   2 +-\n";

test("a diff inside the budget is carried whole", () => {
  const diff = [section("src/a.ts", 10), section("src/b.ts", 10)].join("\n");
  const s = buildState(diff, STAT, { maxChars: 10_000 });
  assert.equal(s.truncated, false);
  assert.deepEqual(s.omitted_files, []);
  assert.deepEqual(s.changed_files, ["src/a.ts", "src/b.ts"]);
  assert.equal(s.diff, diff);
  assert.equal(s.stat, STAT);
});

test("over budget, the smallest sections are kept and the rest are named", () => {
  const diff = [section("src/big.ts", 5_000), section("src/small.ts", 10)].join("\n");
  const s = buildState(diff, STAT, { maxChars: 500 });
  assert.equal(s.truncated, true);
  assert.deepEqual(s.omitted_files, ["src/big.ts"]);
  assert.match(s.diff, /src\/small\.ts/);
  assert.equal(s.diff.includes("src/big.ts"), false);
  assert.deepEqual(s.changed_files, ["src/big.ts", "src/small.ts"]);
});

test("the stat survives truncation so every file is still named", () => {
  const diff = section("src/big.ts", 5_000);
  const s = buildState(diff, STAT, { maxChars: 100 });
  assert.equal(s.truncated, true);
  assert.equal(s.stat, STAT);
  assert.equal(s.diff, "");
});

test("an empty diff is not truncated", () => {
  const s = buildState("", "", { maxChars: 100 });
  assert.equal(s.truncated, false);
  assert.deepEqual(s.changed_files, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/state.test.ts`
Expected: FAIL, `Cannot find module '../src/state.ts'`.

- [ ] **Step 3: Write the implementation**

`src/state.ts`:

```ts
/**
 * The diff, as the one `state` every question is asked against.
 *
 * Jev's two ceilings are the whole request at 64Ki input tokens and the
 * `state` alone at 32Ki, and the state's is the one that fills up first. A
 * diff over that budget is cut by dropping whole file sections, smallest
 * first, because keeping the greatest NUMBER of files is what a judgment
 * about which tests a change touches actually needs -- one 4000-line
 * generated file should not push nine hand-edited ones out.
 *
 * What was dropped is named in the state rather than silently missing, and
 * `git diff --stat` is carried whole, so a question about a test in an
 * omitted file is answered by a model that at least knows the file changed.
 */
import { splitDiffByFile } from "./diff.ts";

export interface StatePayload {
  reviewing: string;
  changed_files: string[];
  stat: string;
  diff: string;
  truncated: boolean;
  omitted_files: string[];
}

/**
 * Characters, not tokens. The state budget is 32Ki tokens and source text
 * runs near 3.6 characters per token, which would put the ceiling around
 * 118k; 96k leaves room for the estimate being wrong in the direction that
 * costs a request.
 */
export const DEFAULT_MAX_CHARS = 96_000;

export interface StateOptions {
  maxChars?: number;
}

export function buildState(diff: string, stat: string, { maxChars = DEFAULT_MAX_CHARS }: StateOptions = {}): StatePayload {
  const sections = splitDiffByFile(diff);
  const changed = [...sections.keys()];
  const base: StatePayload = {
    reviewing: "a git diff",
    changed_files: changed,
    stat,
    diff,
    truncated: false,
    omitted_files: [],
  };
  if (diff.length <= maxChars) return base;

  const bySize = [...sections.entries()].sort((a, b) => a[1].length - b[1].length);
  const kept: Array<[string, string]> = [];
  let used = 0;
  for (const entry of bySize) {
    if (used + entry[1].length + 1 > maxChars) continue;
    kept.push(entry);
    used += entry[1].length + 1;
  }
  const keptNames = new Set(kept.map(([f]) => f));
  // Emit in the diff's own order, not in size order: a diff read out of order
  // is harder to follow and carries no more information.
  const ordered = changed.filter((f) => keptNames.has(f)).map((f) => sections.get(f)!);
  return {
    ...base,
    diff: ordered.join("\n"),
    truncated: true,
    omitted_files: changed.filter((f) => !keptNames.has(f)),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/state.test.ts`
Expected: PASS, `pass 4`.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts
git commit -m "feat: build the diff state inside Jev's state budget"
```

---

## Task 11: Orchestration and replay (`src/run.ts`)

**Files:**
- Create: `src/run.ts`
- Test: `test/run.test.ts`

- [ ] **Step 1: Write the failing test**

`test/run.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, score, replay, pickFramework } from "../src/run.ts";
import type { AskClient } from "../src/jev.ts";
import { testId } from "../src/types.ts";
import type { TestCase } from "../src/types.ts";

function mk(file: string, path: string[], over: Partial<TestCase> = {}): TestCase {
  return { file, titlePath: path, line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function client(answers: Record<string, unknown>): AskClient {
  return {
    model: "jev-latest",
    servedModel: "jev-latest",
    spent: { calls: 1, inputTokens: 1, outputTokens: 0, ms: 1, retried: 0, rateLimited: 0, tokensPerSecond: 1, splits: 0, usd: 0 },
    askSplitting: async () => ({ answers, usage: { input_tokens: 1 } }),
  };
}

test("pickFramework returns the single framework present", () => {
  assert.equal(pickFramework([mk("a.test.ts", ["x"])]), "vitest");
});

test("pickFramework throws when the set is mixed", () => {
  const tests = [mk("a.test.ts", ["x"]), mk("e2e/a.spec.ts", ["y"], { framework: "playwright" })];
  assert.throws(() => pickFramework(tests), /vitest.*playwright|playwright.*vitest/);
});

test("pickFramework treats unknown as its own framework and still throws on a mix", () => {
  const tests = [mk("a.test.ts", ["x"]), mk("b.test.ts", ["y"], { framework: "unknown" })];
  assert.throws(() => pickFramework(tests), /--format/);
});

test("score asks one question per test and reads the answers back by index", async () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["cold"], { line: 9 })];
  const answers = await score(tests, { reviewing: "a git diff", changed_files: [], stat: "", diff: "", truncated: false, omitted_files: [] }, {
    client: client({ q0000: { score: 3, confidence: 0.9 }, q0001: { score: 0, confidence: 0.9 } }),
  });
  assert.deepEqual(answers.get("q0000"), { value: 3, confidence: 0.9 });
  assert.deepEqual(answers.get("q0001"), { value: 0, confidence: 0.9 });
});

test("score leaves an unanswered question null rather than inventing a zero", async () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["lost"], { line: 9 })];
  const answers = await score(tests, { reviewing: "a git diff", changed_files: [], stat: "", diff: "", truncated: false, omitted_files: [] }, {
    client: client({ q0000: { score: 3, confidence: 0.9 } }),
  });
  assert.equal(answers.get("q0001"), null);
});

test("collect pairs each test with whether the diff touched it", () => {
  const edited = mk("a.test.ts", ["edited"], { line: 10, endLine: 20 });
  const untouched = mk("a.test.ts", ["untouched"], { line: 40, endLine: 44 });
  const ranges = new Map([["a.test.ts", [[12, 13]] as Array<[number, number]>]]);
  // Which one, not how many: a `collect` that returned the wrong test would
  // satisfy a size check and quietly run the wrong half of the suite.
  assert.deepEqual([...collect([edited, untouched], ranges)], [testId(edited)]);
});

test("replay re-gates a record without a client", () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["mild"], { line: 9 })];
  const record = {
    version: 1 as const,
    createdAt: "2026-09-21T00:00:00.000Z",
    base: null,
    framework: "vitest" as const,
    tests,
    touched: [],
    answers: { q0000: { value: 3, confidence: 0.9 }, q0001: { value: 1.5, confidence: 0.9 } },
    fallback: null,
  };
  assert.deepEqual(replay(record, { cutoff: 2.0 }).selected.map((t) => t.titlePath[0]), ["hot"]);
  assert.deepEqual(replay(record, { cutoff: 1.0 }).selected.map((t) => t.titlePath[0]), ["hot", "mild"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/run.test.ts`
Expected: FAIL, `Cannot find module '../src/run.ts'`.

- [ ] **Step 3: Write the implementation**

`src/run.ts`:

```ts
/**
 * The run: a diff and a repository in, a selection and the runner's arguments
 * out.
 *
 * The only part of the program that touches the network and the filesystem at
 * once. Everything it decides with is a pure function it calls, and
 * everything it learns is written to a record, so `replay` can reach the same
 * selection again for free under a different cutoff.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDiff, touchesChange } from "./diff.ts";
import type { ChangedRanges } from "./diff.ts";
import { detectFramework, findTestFiles } from "./framework.ts";
import { extractTests } from "./extract.ts";
import { buildState } from "./state.ts";
import type { StatePayload } from "./state.ts";
import { buildQuestion, questionId, readAnswer } from "./questions.ts";
import type { ScoreQuestion } from "./questions.ts";
import { gate } from "./gate.ts";
import type { GateOptions } from "./gate.ts";
import { buildFilter } from "./filter.ts";
import type { FilterArgs } from "./filter.ts";
import { Jev, mapLimit, DEFAULT_CONCURRENCY } from "./jev.ts";
import type { AskClient, Spend } from "./jev.ts";
import { testId } from "./types.ts";
import type { Answer, Framework, Selection, TestCase } from "./types.ts";

/** Where a run's answers are kept, for `--replay`. */
export const RECORD_DIR = ".jev-test-filter";
export const RECORD_FILE = "last.json";

export interface RunRecord {
  version: 1;
  createdAt: string;
  base: string | null;
  framework: Framework;
  tests: TestCase[];
  /** `testId` of every test the diff touched. */
  touched: string[];
  answers: Record<string, Answer | null>;
  fallback: string | null;
}

/**
 * The framework the run is for.
 *
 * A repository with Vitest unit tests and Playwright specs is normal, and
 * there is no single command that runs both, so a mixed set is a question for
 * the user rather than a guess for this function.
 */
export function pickFramework(tests: TestCase[]): Framework {
  const kinds = [...new Set(tests.map((t) => t.framework))];
  if (kinds.length === 1) return kinds[0]!;
  throw new Error(
    `the selected tests span more than one framework (${kinds.join(", ")}); ` +
      `narrow the run with a path argument or pick one with --format`,
  );
}

/** The tests whose own bodies the diff touched. Keyed by `testId`. */
export function collect(tests: TestCase[], ranges: ChangedRanges): Set<string> {
  const out = new Set<string>();
  for (const t of tests) {
    if (touchesChange(ranges, t.file, t.line, t.endLine)) out.add(testId(t));
  }
  return out;
}

export interface ScoreOptions {
  client?: AskClient | null;
  concurrency?: number;
  /**
   * Questions per request. The server has no documented cap on the number of
   * questions and over a thousand in one request is fine, but a batch bounds
   * how much one `max_tokens_exceeded` split has to redo.
   */
  batchSize?: number;
}

/**
 * Ask about every test.
 *
 * Answers come back keyed by question id, and a question with no answer stays
 * null: the gate selects a test with no answer, and a zero here would silently
 * deselect it instead.
 */
export async function score(
  tests: TestCase[],
  state: StatePayload,
  { client = null, concurrency = DEFAULT_CONCURRENCY, batchSize = 400 }: ScoreOptions = {},
): Promise<Map<string, Answer | null>> {
  const jev = client ?? new Jev();
  const out = new Map<string, Answer | null>();
  tests.forEach((_, i) => out.set(questionId(i), null));

  const batches: Array<Record<string, ScoreQuestion>> = [];
  for (let i = 0; i < tests.length; i += batchSize) {
    const batch: Record<string, ScoreQuestion> = {};
    for (let j = i; j < Math.min(i + batchSize, tests.length); j += 1) {
      const id = questionId(j);
      batch[id] = buildQuestion(tests[j]!, id);
    }
    batches.push(batch);
  }

  const responses = await mapLimit(batches, concurrency, (batch) => jev.askSplitting(state, batch));
  for (const res of responses) {
    for (const [id, raw] of Object.entries(res.answers ?? {})) {
      if (out.has(id)) out.set(id, readAnswer(raw));
    }
  }
  return out;
}

export interface RunOptions extends GateOptions {
  cwd?: string;
  base?: string | null;
  staged?: boolean;
  paths?: string[];
  /** Restrict the run to one framework instead of requiring a single one. */
  format?: Framework | null;
  client?: AskClient | null;
  concurrency?: number;
  batchSize?: number;
  fileThreshold?: number;
  /** Extract and gate but never call Jev; every test scores as missing. */
  dryRun?: boolean;
}

export interface RunResult {
  selection: Selection;
  framework: Framework;
  filter: FilterArgs;
  record: RunRecord;
  spent: Spend | null;
}

/**
 * A selection is an optimization and never a correctness gate, so every
 * failure below takes the same exit: run everything, and say why on the
 * result rather than in a log nobody reads.
 */
function everything(tests: TestCase[], reason: string): Selection {
  return {
    verdicts: tests.map((t, i) => ({ id: questionId(i), test: t, answer: null, reason: "missing", selected: true })),
    selected: tests,
    all: tests,
    fallback: reason,
  };
}

export async function run(opts: RunOptions = {}): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const diff = await loadDiff({ cwd, base: opts.base ?? null, staged: opts.staged ?? false });

  const files = await findTestFiles(cwd, opts.paths ?? []);
  const all: TestCase[] = [];
  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8");
    const framework = detectFramework(source, file);
    if (opts.format && framework !== opts.format) continue;
    all.push(...extractTests(source, file, framework));
  }

  if (all.length === 0) {
    const record: RunRecord = {
      version: 1,
      createdAt: new Date().toISOString(),
      base: opts.base ?? null,
      framework: opts.format ?? "unknown",
      tests: [],
      touched: [],
      answers: {},
      fallback: "no tests were extracted",
    };
    const selection = everything([], "no tests were extracted");
    return { selection, framework: record.framework, filter: { mode: "all", argv: [] }, record, spent: null };
  }

  const framework = opts.format ?? pickFramework(all);
  const touched = collect(all, diff.ranges);
  const state = buildState(diff.text, diff.stat);

  let answers = new Map<string, Answer | null>();
  let spent: Spend | null = null;
  let selection: Selection;
  if (opts.dryRun) {
    selection = everything(all, "--dry-run: no questions were asked");
  } else {
    let failure: string | null = null;
    try {
      const client = opts.client ?? new Jev();
      answers = await score(all, state, {
        client,
        ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
        ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
      });
      spent = client.spent;
    } catch (err: unknown) {
      failure = `jev failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Gating is pure and offline, so it stays outside the try: a bug in the
    // gate must not be reported to the user as a network failure.
    selection = failure === null ? gate(all, answers, touched, opts) : everything(all, failure);
  }

  // A truncated diff that still deselects most of the suite is a selection
  // made from a state that was missing the change it should have judged.
  if (selection.fallback === null && state.truncated && selection.selected.length / all.length < 0.5) {
    selection = everything(all, "the diff did not fit the state budget and the selection was small");
  }

  const record: RunRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    base: opts.base ?? null,
    framework,
    tests: all,
    touched: [...touched],
    answers: Object.fromEntries(answers),
    fallback: selection.fallback,
  };

  const filter =
    selection.fallback === null
      ? buildFilter(selection, framework, opts.fileThreshold === undefined ? {} : { fileThreshold: opts.fileThreshold })
      : { mode: "all" as const, argv: [] };

  return { selection, framework, filter, record, spent };
}

/** Re-gate a recorded run at today's cutoffs, offline. */
export function replay(record: RunRecord, opts: GateOptions = {}): Selection {
  if (record.fallback !== null) return everything(record.tests, record.fallback);
  const answers = new Map(Object.entries(record.answers));
  return gate(record.tests, answers, new Set(record.touched), opts);
}

export async function saveRecord(cwd: string, record: RunRecord): Promise<string> {
  const dir = join(cwd, RECORD_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, RECORD_FILE);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

export async function loadRecord(path: string): Promise<RunRecord> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as RunRecord;
  if (parsed.version !== 1) throw new Error(`unsupported record version ${String(parsed.version)}`);
  return parsed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/run.test.ts`
Expected: PASS, `pass 7`.

- [ ] **Step 5: Run the whole suite and the type checker**

Run: `pkf run check`
Expected: `tsc --noEmit` clean, every test file passing.

- [ ] **Step 6: Commit**

```bash
git add src/run.ts test/run.test.ts
git commit -m "feat: orchestrate a run and replay a recorded one offline"
```

---

## Task 12: The CLI (`src/cli.ts`)

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, renderLine, renderJson, execArgv } from "../src/cli.ts";
import type { RunResult } from "../src/run.ts";
import type { TestCase } from "../src/types.ts";

function mk(name: string, over: Partial<TestCase> = {}): TestCase {
  return { file: "a.test.ts", titlePath: [name], line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function result(argv: string[], mode: "all" | "none" | "files" | "pattern" | "locations"): RunResult {
  const t = mk("hot");
  return {
    selection: {
      verdicts: [{ id: "q0000", test: t, answer: { value: 3, confidence: 0.9 }, reason: "scored", selected: true }],
      selected: [t],
      all: [t, mk("cold", { line: 9 })],
      fallback: null,
    },
    framework: "vitest",
    filter: { mode, argv },
    record: { version: 1, createdAt: "", base: null, framework: "vitest", tests: [], touched: [], answers: {}, fallback: null },
    spent: null,
  };
}

test("parseCliArgs reads the flags and the paths", () => {
  const a = parseCliArgs(["--base", "main", "--cutoff", "1.5", "src", "e2e"]);
  assert.equal(a.base, "main");
  assert.equal(a.cutoff, 1.5);
  assert.deepEqual(a.paths, ["src", "e2e"]);
  assert.equal(a.json, false);
});

test("parseCliArgs splits the command after --exec", () => {
  const a = parseCliArgs(["--base", "main", "--exec", "--", "vitest", "run"]);
  assert.deepEqual(a.exec, ["vitest", "run"]);
  assert.deepEqual(a.paths, []);
});

test("parseCliArgs rejects an unknown format", () => {
  assert.throws(() => parseCliArgs(["--format", "mocha"]), /mocha/);
});

test("renderLine quotes an argument that needs it", () => {
  assert.equal(renderLine(result(["a.test.ts", "-t", "^(?:Cart > totals)$"], "pattern")), "a.test.ts -t '^(?:Cart > totals)$'");
});

test("renderLine is empty when everything is selected", () => {
  assert.equal(renderLine(result([], "all")), "");
});

test("execArgv appends the filter to the command", () => {
  assert.deepEqual(execArgv(["vitest", "run"], result(["a.test.ts"], "files")), ["vitest", "run", "a.test.ts"]);
});

test("execArgv refuses to run when nothing was selected", () => {
  assert.equal(execArgv(["vitest", "run"], result([], "none")), null);
});

test("renderJson reports every test with its reason", () => {
  const json = JSON.parse(renderJson(result(["a.test.ts"], "files"))) as Record<string, unknown>;
  assert.equal(json.framework, "vitest");
  assert.equal(json.mode, "files");
  assert.deepEqual(json.argv, ["a.test.ts"]);
  const tests = json.tests as Array<Record<string, unknown>>;
  assert.equal(tests.length, 1);
  assert.equal(tests[0]!.reason, "scored");
  assert.equal(tests[0]!.name, "hot");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cli.test.ts`
Expected: FAIL, `Cannot find module '../src/cli.ts'`.

- [ ] **Step 3: Write the implementation**

`src/cli.ts`:

```ts
#!/usr/bin/env node
/**
 * The command line.
 *
 * Three shapes, because "easy to wire in" means different things in a
 * Makefile, in a shell and in another program:
 *
 *   jev-test-filter --base main                 -> arguments on stdout
 *   jev-test-filter --base main --exec -- vitest run
 *   jev-test-filter --base main --json          -> the whole scoring
 *
 * Only this file writes to a stream or exits.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { displayName } from "./questions.ts";
import { fullName } from "./filter.ts";
import { loadRecord, replay, run, saveRecord } from "./run.ts";
import type { RunResult } from "./run.ts";
import type { Framework } from "./types.ts";

const FORMATS: readonly string[] = ["vitest", "jest", "node", "playwright", "auto"];

export interface CliArgs {
  base: string | null;
  staged: boolean;
  paths: string[];
  format: Framework | null;
  cutoff: number | undefined;
  concurrency: number | undefined;
  json: boolean;
  dryRun: boolean;
  replayPath: string | null;
  exec: string[] | null;
  help: boolean;
}

/**
 * `--exec` takes everything after the `--` that follows it, so the runner's
 * own flags never have to be escaped past this parser.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const execAt = argv.indexOf("--exec");
  const own = execAt === -1 ? argv : argv.slice(0, execAt);
  let exec: string[] | null = null;
  if (execAt !== -1) {
    const rest = argv.slice(execAt + 1);
    exec = rest[0] === "--" ? rest.slice(1) : rest;
    if (exec.length === 0) throw new Error("--exec needs a command, e.g. --exec -- vitest run");
  }

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      staged: { type: "boolean", default: false },
      format: { type: "string", default: "auto" },
      cutoff: { type: "string" },
      concurrency: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      replay: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const format = String(values.format);
  if (!FORMATS.includes(format)) {
    throw new Error(`unknown --format ${format}; expected one of ${FORMATS.join(", ")}`);
  }

  return {
    base: values.base === undefined ? null : String(values.base),
    staged: Boolean(values.staged),
    paths: positionals,
    format: format === "auto" ? null : (format as Framework),
    cutoff: values.cutoff === undefined ? undefined : Number(values.cutoff),
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
    json: Boolean(values.json),
    dryRun: Boolean(values["dry-run"]),
    replayPath: values.replay === undefined ? null : String(values.replay),
    exec,
    help: Boolean(values.help),
  };
}

/** Shell-safe single quoting, for a line a human will paste. */
function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function renderLine(res: RunResult): string {
  return res.filter.argv.map(quote).join(" ");
}

/** The command to run, or null when nothing was selected. */
export function execArgv(cmd: string[], res: RunResult): string[] | null {
  if (res.filter.mode === "none") return null;
  return [...cmd, ...res.filter.argv];
}

export function renderJson(res: RunResult): string {
  return `${JSON.stringify(
    {
      framework: res.framework,
      mode: res.filter.mode,
      argv: res.filter.argv,
      fallback: res.selection.fallback,
      selected: res.selection.selected.length,
      total: res.selection.all.length,
      spent: res.spent,
      tests: res.selection.verdicts.map((v) => ({
        file: v.test.file,
        name: displayName(v.test),
        pattern_name: fullName(v.test),
        line: v.test.line,
        selected: v.selected,
        reason: v.reason,
        score: v.answer?.value ?? null,
        confidence: v.answer?.confidence ?? null,
      })),
    },
    null,
    2,
  )}\n`;
}

const HELP = `jev-test-filter — score every test against a git diff and emit runner arguments

Usage:
  jev-test-filter [options] [paths...]

Options:
  --base <ref>        compare against the merge base with <ref>, as a pull request does
  --staged            use the staged change instead of the working tree
  --format <name>     vitest | jest | node | playwright | auto  (default: auto)
  --cutoff <n>        select at or above this score level (default: 2)
  --concurrency <n>   requests in flight at once
  --json              print the full scoring instead of the arguments
  --dry-run           extract and report without calling Jev
  --replay <file>     re-gate a recorded run offline (default: .jev-test-filter/last.json)
  --exec -- <cmd...>  append the arguments to <cmd...> and run it
  -h, --help          this text

Environment:
  TYPESAFE_API_KEY    required unless --dry-run or --replay
`;

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err: unknown) {
    process.stderr.write(`jev-test-filter: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let res: RunResult;
  if (args.replayPath !== null) {
    const record = await loadRecord(args.replayPath || ".jev-test-filter/last.json");
    const selection = replay(record, args.cutoff === undefined ? {} : { cutoff: args.cutoff });
    const { buildFilter } = await import("./filter.ts");
    res = {
      selection,
      framework: record.framework,
      filter: selection.fallback === null ? buildFilter(selection, record.framework) : { mode: "all", argv: [] },
      record,
      spent: null,
    };
  } else {
    res = await run({
      base: args.base,
      staged: args.staged,
      paths: args.paths,
      format: args.format,
      dryRun: args.dryRun,
      ...(args.cutoff === undefined ? {} : { cutoff: args.cutoff }),
      ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
    });
    await saveRecord(process.cwd(), res.record);
  }

  if (res.selection.fallback !== null) {
    process.stderr.write(`jev-test-filter: running everything (${res.selection.fallback})\n`);
  } else {
    const { selected, all } = res.selection;
    process.stderr.write(`jev-test-filter: ${selected.length}/${all.length} tests selected (${res.filter.mode})\n`);
  }

  if (args.json) {
    process.stdout.write(renderJson(res));
    return 0;
  }

  if (args.exec) {
    const argv = execArgv(args.exec, res);
    if (argv === null) {
      process.stderr.write("jev-test-filter: nothing selected; not running\n");
      return 0;
    }
    return await new Promise<number>((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", (err) => {
        process.stderr.write(`jev-test-filter: ${err.message}\n`);
        resolve(127);
      });
    });
  }

  process.stdout.write(`${renderLine(res)}\n`);
  return 0;
}

// Only run when invoked as a program, so the tests can import the renderers.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`jev-test-filter: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/cli.test.ts`
Expected: PASS, `pass 8`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: add the command line with stdout, --exec, --json and --replay"
```

---

## Task 13: End-to-end against the three runners

This is the task that would have caught the two bugs the spec was written around: a name pattern in the wrong spelling, and a Playwright selection by name.

**Files:**
- Create: `test/fixtures/vitest/cart.test.ts`, `test/fixtures/node/cart.test.cjs`, `test/fixtures/playwright/login.spec.ts`
- Create: `test/e2e.test.ts`

- [ ] **Step 1: Write the fixtures**

`test/fixtures/vitest/cart.test.ts`:

```ts
import { describe, it, test } from "vitest";

describe("Cart", () => {
  describe("applyDiscount", () => {
    it("clamps at zero", () => {});
    it("rounds half up", () => {});
  });
  test("totals", () => {});
});
test("top level", () => {});
```

`test/fixtures/node/cart.test.cjs`. The extension is not incidental: this
package is `"type": "module"`, so a `.js` file is loaded as ESM and its
`require` call throws before a single test runs. `.cjs` keeps the CommonJS
spelling -- which real repositories do use, and which `detectFramework` has to
read -- and keeps the file executable by the spawned runner below.

```js
const { describe, it } = require("node:test");

describe("Cart", () => {
  describe("applyDiscount", () => {
    it("clamps at zero", () => {});
    it("rounds half up", () => {});
  });
  it("totals", () => {});
});
```

`test/fixtures/playwright/login.spec.ts`:

```ts
import { test } from "@playwright/test";

test.describe("Login", () => {
  test("succeeds", async () => {});
  test("fails on a bad password", async () => {});
});
```

- [ ] **Step 2: Write the failing test**

`test/e2e.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractTests } from "../src/extract.ts";
import { detectFramework } from "../src/framework.ts";
import { buildFilter, fullName } from "../src/filter.ts";
import type { Selection, TestCase } from "../src/types.ts";

const HERE = new URL(".", import.meta.url).pathname;

async function load(rel: string): Promise<TestCase[]> {
  const file = join("test/fixtures", rel);
  const source = await readFile(join(HERE, "fixtures", rel), "utf8");
  return extractTests(source, file, detectFramework(source));
}

function sel(all: TestCase[], selected: TestCase[]): Selection {
  return {
    all,
    selected,
    verdicts: all.map((t, i) => ({
      id: `q${i}`,
      test: t,
      answer: null,
      reason: selected.includes(t) ? "scored" : "below",
      selected: selected.includes(t),
    })),
    fallback: null,
  };
}

test("the vitest pattern selects exactly the chosen tests under vitest's own spelling", async () => {
  const all = await load("vitest/cart.test.ts");
  assert.equal(all.length, 4);
  const selected = [all[0]!, all[3]!];
  const f = buildFilter(sel(all, selected), "vitest");
  assert.equal(f.mode, "pattern");
  const re = new RegExp(f.argv[1]!);
  // vitest joins a full name with " > ".
  for (const t of all) {
    assert.equal(re.test(t.titlePath.join(" > ")), selected.includes(t), fullName(t));
  }
});

test("the node:test pattern selects exactly the chosen tests under the space spelling", async () => {
  const all = await load("node/cart.test.cjs");
  assert.equal(all.length, 3);
  const selected = [all[1]!];
  const f = buildFilter(sel(all, selected), "node");
  assert.equal(f.argv.filter((a) => a === "--test-name-pattern").length, 1);
  const re = new RegExp(f.argv[1]!);
  // node:test joins a full name with a single space.
  for (const t of all) {
    assert.equal(re.test(t.titlePath.join(" ")), selected.includes(t), t.titlePath.join(" "));
  }
  // And it must not select a suite, which would run every test under it.
  assert.equal(re.test("Cart"), false);
  assert.equal(re.test("Cart applyDiscount"), false);
});

test("node:test really honours the generated filter, in a real process", async () => {
  const all = await load("node/cart.test.cjs");
  const f = buildFilter(sel(all, [all[1]!]), "node");
  assert.equal(f.mode, "pattern");

  // The only check in the suite that runs the runner. A pattern the runner
  // does not apply is invisible to every other test here: it produces a green
  // run of the WRONG tests. Node silently ignores `--test-name-pattern` when
  // it follows a positional, which is why `buildFilter` puts the flag first,
  // and this is what holds that ordering in place.
  const res = spawnSync(process.execPath, ["--test", ...f.argv], {
    cwd: join(HERE, ".."),
    encoding: "utf8",
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /rounds half up/);
  assert.doesNotMatch(res.stdout, /clamps at zero/);
  assert.doesNotMatch(res.stdout, /totals/);
});

test("playwright is selected by location and every line points at a real test", async () => {
  const all = await load("playwright/login.spec.ts");
  assert.equal(all.length, 2);
  const f = buildFilter(sel(all, [all[0]!]), "playwright");
  assert.deepEqual(f.argv, ["test/fixtures/playwright/login.spec.ts:4"]);
  const source = await readFile(join(HERE, "fixtures/playwright/login.spec.ts"), "utf8");
  assert.match(source.split("\n")[all[0]!.line - 1]!, /test\("succeeds"/);
});
```

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `node --test test/e2e.test.ts`
Expected first: FAIL on the fixture paths or counts. Fix the fixture, not the matcher. Then: PASS, `pass 4`.

Then `node --test "test/*.test.ts"` must be `tests 86 / pass 86 / fail 0`. If it
is larger, the glob is descending into `test/fixtures/` and collecting a file
that imports a framework this package does not depend on.

- [ ] **Step 4: Verify the patterns against the real runners by hand, once**

These are not automated — they need the runners installed — but run them once and record what you saw in the commit message.

```bash
cd $(mktemp -d) && npm init -y >/dev/null && npm i -D vitest >/dev/null
cp <repo>/test/fixtures/vitest/cart.test.ts .
npx vitest run -t '^(?:Cart > applyDiscount > clamps at zero|top level)$' cart.test.ts --reporter=verbose
```

Expected: 2 passed, 2 skipped.

```bash
node --test --test-name-pattern '^(?:Cart applyDiscount rounds half up)$' <repo>/test/fixtures/node/cart.test.cjs
```

Expected: `tests 1`, and the reporter shows `rounds half up` only.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures test/e2e.test.ts
git commit -m "test: verify the generated filters against every framework's own spelling"
```

---

## Task 14: README and release wiring

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: `package.json` (already written in Task 1; only verify)

- [ ] **Step 1: Write `LICENSE`**

MIT, `Copyright (c) 2026 mizchi`.

- [ ] **Step 2: Write `README.md`**

It must contain, in this order: what the tool does in two sentences; an install line; the three invocation shapes; a table of the per-framework selection behaviour copied from the "Facts verified before this plan was written" section above, because it is the part a user will otherwise get wrong; the fail-safe list; a "Known limitations" section; and the environment variables. English, per the repository convention.

"Known limitations" must name these three, because each is a thing a user will
otherwise report as a bug:

- A repository whose tests span more than one framework needs `--format`.
  There is no single command that runs Vitest and Playwright together, so the
  tool asks rather than guessing.
- A test whose title is not a literal -- an interpolated template, a `.each`
  row -- cannot be named in a pattern. Such tests are always selected, and one
  of them in the selection drops the whole run to file-level filtering.
- Selection is static. A test that reaches changed code only through a runtime
  indirection the source does not show is judged on what the source shows.

- [ ] **Step 3: Verify the package builds and the bin runs**

```bash
pnpm run build
node dist/cli.js --help
node dist/cli.js --dry-run
```

Expected: the help text, then a line on stderr reading `running everything (--dry-run: no questions were asked)` and an empty line on stdout.

- [ ] **Step 4: Verify against this repository with a real key**

```bash
source ~/.profile
git commit --allow-empty -m "wip" >/dev/null
node dist/cli.js --base HEAD~1 --format node --json | head -40
```

`--format node` is required here and that is the tool working as designed, not
a workaround: `test/fixtures/` holds a Vitest file and a Playwright spec, so
this repository genuinely contains tests of three frameworks, and there is no
single command that runs all three. A repository with Vitest unit tests and
Playwright end-to-end specs -- the common arrangement -- needs the same flag.

Expected: JSON with `framework: "node"`, a `spent` block with a non-zero `inputTokens`, and every test carrying a `score` and a `reason`.

Then confirm the emitted filter is honoured rather than trusting the count:

```bash
node --test $(node dist/cli.js --base HEAD~1 --format node)
```

Expected: the test count matches the `selected` figure the previous command
reported, not the `total`.

- [ ] **Step 5: Run the full gate**

Run: `pkf run check`
Expected: typecheck clean, every test passing.

- [ ] **Step 6: Commit**

```bash
git add README.md LICENSE
git commit -m "docs: document the three invocation shapes and the per-framework behaviour"
```

---

## Self-review notes

- Spec coverage: every module in the spec's table has a task (2–12); the fail-safe list is implemented in `run.ts` and exercised in Task 11; the verified runner behaviour is implemented in `filter.ts` and re-checked end to end in Task 13; the repository conventions are Task 1 and Task 14.
- Task 6 deliberately depends on Task 7's `questionId`; the step text says so and holds the commit rather than leaving a broken import.
- Names used across tasks and kept consistent: `TestCase`, `Answer`, `Verdict`, `Selection`, `testId`, `questionId`, `readAnswer`, `displayName`, `fullName`, `buildFilter`, `FilterArgs`, `gate`, `decide`, `buildState`, `StatePayload`, `loadDiff`, `splitDiffByFile`, `touchesChange`, `extractTests`, `detectFramework`, `findTestFiles`, `run`, `replay`, `score`, `collect`, `pickFramework`, `RunRecord`, `RunResult`.
