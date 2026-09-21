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
