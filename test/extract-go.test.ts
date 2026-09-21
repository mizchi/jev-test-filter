import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGoTests, goLiteral } from "../src/extract-go.ts";

const SRC = `
package cart

import "testing"

func TestApplyDiscount(t *testing.T) {
	t.Run("clamps at zero", func(t *testing.T) {})
	t.Run(` + "`halves the total`" + `, func(t *testing.T) {})
}

func TestItemCount(t *testing.T) {}

func TestTable(t *testing.T) {
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {})
	}
}

func helper(t *testing.T) {}
func BenchmarkThing(b *testing.B) {}
`;

test("goLiteral reads both string spellings and refuses the rest", () => {
  assert.equal(goLiteral('"a b"'), "a b");
  assert.equal(goLiteral("`a b`"), "a b");
  assert.equal(goLiteral("tc.name"), null);
});

test("a test function with subtests yields one case per subtest", () => {
  const found = extractGoTests(SRC, "cart/cart_test.go");
  const names = found.map((t) => t.titlePath.join("/"));
  assert.deepEqual(names, [
    "TestApplyDiscount/clamps at zero",
    "TestApplyDiscount/halves the total",
    "TestItemCount",
    "TestTable/",
  ]);
});

test("a subtest whose name is not a literal is dynamic", () => {
  const found = extractGoTests(SRC, "cart/cart_test.go");
  assert.deepEqual(found.map((t) => t.dynamic), [false, false, false, true]);
});

test("only Test functions are collected", () => {
  const found = extractGoTests(SRC, "cart/cart_test.go");
  assert.equal(found.some((t) => t.titlePath[0] === "helper"), false);
  assert.equal(found.some((t) => t.titlePath[0] === "BenchmarkThing"), false);
});

test("the file and 1-based lines are carried", () => {
  const found = extractGoTests(SRC, "cart/cart_test.go");
  assert.equal(found[0]!.file, "cart/cart_test.go");
  assert.equal(found[0]!.framework, "go");
  assert.equal(found[0]!.line, 7);
});
