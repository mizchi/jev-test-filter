import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiff, touchesChange } from "../src/diff.ts";
import { gitEnv } from "./git-env.ts";

// Retain these isolated fixtures; no real repository or model API is used.
function fixture(mode: "working" | "staged" | "base", packageDirectory = "pkg") {
  const root = mkdtempSync(join(tmpdir(), "jev-subdirectory-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv(), encoding: "utf8" });
  git("-c", "init.templateDir=", "init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  for (const directory of [`${packageDirectory}/src`, "pkg-other"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, `${packageDirectory}/src/math.test.ts`), "// unchanged\n// changed test\n");
  writeFileSync(join(root, "pkg-other/math.ts"), "export const value = 1;\n");
  git("add", "."); git("commit", "-qm", "fixture");
  git("branch", "base");
  writeFileSync(join(root, `${packageDirectory}/src/math.test.ts`), "// unchanged\n// changed test body\n");
  writeFileSync(join(root, "pkg-other/math.ts"), "export const value = 2; // neighbor\n");
  if (mode !== "working") git("add", ".");
  if (mode === "base") git("commit", "-qm", "change");
  return { root, git, options: { staged: mode === "staged", base: mode === "base" ? "base" : null } };
}

for (const mode of ["working", "staged", "base"] as const) {
  test(`${mode} diff uses cwd-relative touched ranges but keeps the full model context`, async () => {
    const { root, options } = fixture(mode);
    const fromRoot = await loadDiff({ cwd: root, ...options });
    const fromPackage = await loadDiff({ cwd: join(root, "pkg"), ...options });
    assert.equal(touchesChange(fromRoot.ranges, "pkg/src/math.test.ts", 2, 2), true);
    assert.equal(touchesChange(fromPackage.ranges, "src/math.test.ts", 2, 2), true);
    assert.deepEqual([...fromPackage.ranges.keys()], ["src/math.test.ts"]);
    assert.equal(fromPackage.text, fromRoot.text);
    assert.equal(fromPackage.stat, fromRoot.stat);
    assert.match(fromPackage.text, /neighbor/);
    assert.match(fromPackage.stat, /pkg-other/);
    const nested = await loadDiff({ cwd: join(root, "pkg/src"), ...options });
    assert.equal(touchesChange(nested.ranges, "math.test.ts", 2, 2), true);
    assert.equal(nested.text, fromRoot.text);
  });
}

test("diff.relative config cannot hide changes outside cwd from the model", async () => {
  const { root, git } = fixture("working");
  git("config", "diff.relative", "true");
  const diff = await loadDiff({ cwd: join(root, "pkg") });
  assert.equal(touchesChange(diff.ranges, "src/math.test.ts", 2, 2), true);
  assert.match(diff.text, /neighbor/);
  assert.match(diff.stat, /pkg-other/);
});

test("a whitespace-prefixed directory retains its exact git prefix", async () => {
  const { root } = fixture("working", " pkg");
  const diff = await loadDiff({ cwd: join(root, " pkg") });
  assert.equal(touchesChange(diff.ranges, "src/math.test.ts", 2, 2), true);
  assert.match(diff.text, /neighbor/);
});

test("run selects the edited test as touched despite a confident zero model score", async () => {
  const { run } = await import("../src/run.ts");
  const { root, git } = fixture("working");
  writeFileSync(join(root, "pkg/src/math.test.ts"), 'import { test, expect } from "vitest";\ntest("unchanged", () => expect(1).toBe(1));\n');
  git("add", "pkg/src/math.test.ts"); git("commit", "-qm", "tests");
  writeFileSync(join(root, "pkg/src/math.test.ts"), 'import { test, expect } from "vitest";\ntest("unchanged", () => expect(1).toBe(1));\ntest("added", () => expect(2).toBe(2));\n');
  let context = "";
  const result = await run({ cwd: join(root, "pkg"), format: "vitest", client: {
    model: "fixture", servedModel: "fixture",
    spent: { calls: 1, inputTokens: 1, outputTokens: 0, ms: 1, retried: 0, rateLimited: 0, tokensPerSecond: 1, splits: 0, usd: 0 },
    async askSplitting(state, questions) {
      context = JSON.stringify(state);
      return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { score: 0, confidence: 1 }])) };
    },
  } });
  assert.equal(result.selection.fallback, null);
  assert.deepEqual(result.selection.selected.map(t => t.titlePath), [["added"]]);
  assert.equal(result.selection.verdicts.find(v => v.test.titlePath[0] === "added")?.reason, "touched");
  assert.equal(result.selection.verdicts.find(v => v.test.titlePath[0] === "unchanged")?.reason, "below");
  assert.match(context, /neighbor/);
});
