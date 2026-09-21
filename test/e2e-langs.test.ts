import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractGoTests } from "../src/extract-go.ts";
import { rustTestsIn } from "../src/cargo.ts";
import { buildFilter } from "../src/filter.ts";
import type { Selection, TestCase } from "../src/types.ts";

const HERE = new URL(".", import.meta.url).pathname;

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

test("the go fixture yields the names go test prints", async () => {
  const file = "test/fixtures/go/cart_test.go";
  const source = await readFile(join(HERE, "fixtures/go/cart_test.go"), "utf8");
  const all = extractGoTests(source, file);
  assert.deepEqual(all.map((t) => t.titlePath.join("/")), [
    "TestApplyDiscount/clamps at zero",
    "TestApplyDiscount/halves the total",
    "TestItemCount",
  ]);
  const f = buildFilter(sel(all, [all[0]!]), "go");
  // Selecting one subtest names its whole parent, and only that parent.
  assert.deepEqual(f.argv, ["-run", "^(?:TestApplyDiscount)$", "./test/fixtures/go"]);
});

test("the rust fixture's module paths match what cargo would print", async () => {
  const file = "test/fixtures/rust/lib.rs";
  const source = await readFile(join(HERE, "fixtures/rust/lib.rs"), "utf8");
  const found = rustTestsIn(source, file);
  // `test/fixtures/rust/lib.rs` is not under `src/`, so it contributes no
  // prefix; the chain is the one the `mod`s declare.
  assert.deepEqual([...found.keys()], [
    "tests::apply_discount::clamps_at_zero",
    "tests::apply_discount::halves_the_total",
    "tests::counts_items",
  ]);
});
