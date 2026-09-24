import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// --- history hints from a context ---

/**
 * The questions as 0.1.1 built them, one per line. A test without a hint must
 * be asked exactly this, byte for byte: a question that changed shape for
 * every test the day hints were added would make no run comparable with any
 * run before it.
 */
const SNAPSHOT_CASES: Array<[TestCase, string]> = [
  [t, "q0007"],
  [{ ...t, framework: "playwright", project: "chromium" }, "q0001"],
  [{ ...t, framework: "node", line: 5, endLine: 5 }, "q0002"],
  [{ ...t, framework: "go", titlePath: ["TestCart", "zero"] }, "q0003"],
];

test("a test without a hint is asked exactly what 0.1.1 asked", () => {
  const snapshot = readFileSync(new URL("./snapshots/questions.jsonl", import.meta.url), "utf8");
  const now = SNAPSHOT_CASES.map(([c, id]) => JSON.stringify(buildQuestion(c, id))).join("\n") + "\n";
  assert.equal(now, snapshot);
  const empty = SNAPSHOT_CASES.map(([c, id]) => JSON.stringify(buildQuestion(c, id, []))).join("\n") + "\n";
  assert.equal(empty, snapshot);
});

test("a hint goes into that test's instructions as history", () => {
  const q = buildQuestion(t, "q0007", ["src/cart.ts", "src/money.ts"]);
  assert.equal(q.instructions.history, "This test previously failed when src/cart.ts or src/money.ts changed.");
  // Everything else is what the unhinted question says.
  const { history: _, ...rest } = q.instructions;
  assert.deepEqual(rest, buildQuestion(t, "q0007").instructions);
  assert.deepEqual(q.criteria, SCORE_LEVELS);
});

test("a hinted question still carries no threshold", () => {
  const text = JSON.stringify(buildQuestion(t, "q0000", ["src/cart.ts"]));
  assert.equal(/cutoff|threshold|at least|\d+ times/i.test(text), false);
});
