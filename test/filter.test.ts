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

test("go selects whole top-level functions and narrows to packages", () => {
  const a = mk("cart/cart_test.go", ["TestApplyDiscount", "clamps at zero"], { framework: "go" });
  const b = mk("cart/cart_test.go", ["TestApplyDiscount", "halves the total"], { framework: "go" });
  const c = mk("cart/cart_test.go", ["TestItemCount"], { framework: "go" });
  const d = mk("tax/tax_test.go", ["TestWithTax"], { framework: "go" });
  const f = buildFilter(sel([a, b, c, d], [a, d]), "go");
  assert.equal(f.mode, "pattern");
  assert.deepEqual(f.argv, ["-run", "^(?:TestApplyDiscount|TestWithTax)$", "./cart", "./tax"]);
});

test("go names a parent once however many of its subtests are selected", () => {
  const a = mk("cart/cart_test.go", ["TestApplyDiscount", "clamps at zero"], { framework: "go" });
  const b = mk("cart/cart_test.go", ["TestApplyDiscount", "halves the total"], { framework: "go" });
  const c = mk("cart/cart_test.go", ["TestItemCount"], { framework: "go" });
  const f = buildFilter(sel([a, b, c], [a, b]), "go");
  assert.deepEqual(f.argv, ["-run", "^(?:TestApplyDiscount)$", "./cart"]);
});

test("a go test at the module root is named ./", () => {
  const a = mk("x_test.go", ["TestA"], { framework: "go" });
  const b = mk("x_test.go", ["TestB"], { framework: "go" });
  const f = buildFilter(sel([a, b], [a]), "go");
  assert.deepEqual(f.argv, ["-run", "^(?:TestA)$", "./"]);
});

test("rust selects by exact path after a double dash", () => {
  const a = mk("src/lib.rs", ["tests", "apply_discount", "clamps_at_zero"], { framework: "rust" });
  const b = mk("src/lib.rs", ["tests", "counts_items"], { framework: "rust" });
  const c = mk("", ["macro_generated"], { framework: "rust", line: 0, endLine: 0 });
  const f = buildFilter(sel([a, b, c], [a, c]), "rust");
  assert.equal(f.mode, "exact");
  assert.deepEqual(f.argv, ["--", "--exact", "tests::apply_discount::clamps_at_zero", "macro_generated"]);
});

test("a dynamic go subtest does not drop the run to whole files", () => {
  // Go already filters at the top level, so a nameless subtest costs nothing
  // extra: its parent is named either way.
  const a = mk("cart/cart_test.go", ["TestTable", ""], { framework: "go", dynamic: true });
  const b = mk("cart/cart_test.go", ["TestItemCount"], { framework: "go" });
  const f = buildFilter(sel([a, b], [a]), "go");
  assert.equal(f.mode, "pattern");
  assert.deepEqual(f.argv, ["-run", "^(?:TestTable)$", "./cart"]);
});
