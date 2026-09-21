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
