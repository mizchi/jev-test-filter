/**
 * Go's tests, read out of the source.
 *
 * `go test -list` prints only top-level functions, so it cannot supply what a
 * per-subtest judgment needs. The source can: `func TestXxx` is a leaf when it
 * holds no `t.Run`, and a suite when it does.
 *
 * A `t.Run` whose name is not a literal is the table-driven idiom, and it is
 * `dynamic` for exactly the reason an interpolated Vitest title is -- there is
 * no name to put in a pattern. Go compounds it: a subtest's spaces become
 * underscores, and two subtests that collide after that rewrite get `#01`
 * appended and cannot be told apart by name at all. The filter layer answers
 * both by selecting whole top-level functions.
 */
import { parse } from "@ast-grep/napi";
import { registerLanguages } from "./languages.ts";
import type { TestCase } from "./types.ts";

/**
 * `func TestXxx(...)`. Go's own rule is that what follows `Test` must not
 * start with a lowercase letter, which is what separates `TestFoo` from
 * `Testing`. `Benchmark`, `Fuzz` and `Example` are not what `-run` selects.
 */
const TEST_FUNC = { kind: "function_declaration", has: { field: "name", regex: "^Test($|[^a-z])" } };

/** `t.Run(name, fn)`, by the method's name rather than the receiver's. */
const SUBTEST = {
  kind: "call_expression",
  has: { field: "function", kind: "selector_expression", has: { field: "field", regex: "^Run$" } },
};

/** A Go string literal's text, or null when the argument is not one. */
export function goLiteral(raw: string): string | null {
  if (raw.startsWith("`") && raw.endsWith("`")) return raw.slice(1, -1);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\(.)/g, "$1");
  return null;
}

export function extractGoTests(source: string, file: string): TestCase[] {
  registerLanguages();
  const root = parse("go", source).root();
  const out: TestCase[] = [];

  for (const fn of root.findAll({ rule: TEST_FUNC as never })) {
    const name = fn.field("name")?.text() ?? "";
    const range = fn.range();
    const subs = fn.findAll({ rule: SUBTEST as never });

    if (subs.length === 0) {
      out.push({
        file,
        titlePath: [name],
        line: range.start.line + 1,
        endLine: range.end.line + 1,
        framework: "go",
        dynamic: false,
      });
      continue;
    }

    for (const sub of subs) {
      // child(0) is the opening parenthesis; the name is the first argument.
      const raw = sub.field("arguments")?.child(1)?.text() ?? "";
      const title = goLiteral(raw);
      const at = sub.range();
      out.push({
        file,
        titlePath: [name, title ?? ""],
        line: at.start.line + 1,
        endLine: at.end.line + 1,
        framework: "go",
        dynamic: title === null,
      });
    }
  }
  return out;
}
