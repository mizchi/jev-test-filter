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
