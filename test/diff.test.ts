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
