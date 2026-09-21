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
