/**
 * Which runner a file's tests belong to, and which files to look in.
 *
 * Detection is by import source rather than by configuration, because the
 * configuration says what the project runs and the import says what this file
 * is. A repository with Vitest unit tests and Playwright specs has both, and
 * a per-run answer would be wrong for half of it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, Lang } from "@ast-grep/napi";
import type { Framework } from "./types.ts";

const execFileAsync = promisify(execFile);

/** The grammar to parse a file under, by extension. */
export function langFor(file: string): Lang {
  if (/\.tsx$/.test(file)) return Lang.Tsx;
  if (/\.jsx$/.test(file)) return Lang.Tsx;
  if (/\.[cm]?ts$/.test(file)) return Lang.TypeScript;
  return Lang.JavaScript;
}

/** `foo.test.ts`, `foo.spec.tsx`, `foo.test.mjs`, and the rest of the family. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

/** `require("x")`, with the specifier captured. */
const REQUIRE_RULE = {
  kind: "call_expression",
  all: [
    { has: { field: "function", regex: "^require$" } },
    { has: { field: "arguments", has: { nthChild: 1, kind: "string", pattern: "$SPEC" } } },
  ],
};

/** A string literal's text, without its quotes. */
function unquote(raw: string): string {
  return raw.slice(1, -1);
}

/**
 * Every module specifier the file imports or requires.
 *
 * A parse, not a regular expression. The first version of this matched
 * specifiers in the text, which reads an import written inside a string
 * literal as a real one -- and this tool's own test files carry fixture
 * sources as template literals, so its own repository looked like it held
 * Playwright specs it does not have. There is no way to tell code from a
 * string without parsing, so it parses.
 *
 * The file is parsed once here and once more by the extractor. Tree-sitter is
 * fast enough that the second parse does not show up next to reading the file
 * off disk, and threading a parsed tree between the two would put the grammar
 * choice in the caller.
 */
function specifiers(source: string, file: string): string[] {
  const root = parse(langFor(file), source).root();
  const out: string[] = [];
  for (const kind of ["import_statement", "export_statement"]) {
    for (const node of root.findAll({ rule: { kind } as never })) {
      const src = node.field("source")?.text();
      if (src) out.push(unquote(src));
    }
  }
  for (const node of root.findAll({ rule: REQUIRE_RULE as never })) {
    const spec = node.getMatch("SPEC")?.text();
    if (spec) out.push(unquote(spec));
  }
  return out;
}

/**
 * Playwright wins a tie because a spec that imports `expect` from elsewhere
 * is still a Playwright spec, and selecting a Playwright test by name is the
 * one thing that does not work.
 *
 * `file` only picks the grammar; the default suits a bare source string.
 */
export function detectFramework(source: string, file = "a.ts"): Framework {
  let vitest = false;
  let node = false;
  let jest = false;
  for (const spec of specifiers(source, file)) {
    if (spec === "@playwright/test" || spec.startsWith("@playwright/test/")) return "playwright";
    if (spec === "vitest" || spec.startsWith("vitest/")) vitest = true;
    else if (spec === "node:test") node = true;
    else if (spec === "@jest/globals") jest = true;
  }
  if (vitest) return "vitest";
  if (node) return "node";
  if (jest) return "jest";
  return "unknown";
}

/**
 * The test files to consider.
 *
 * `git ls-files` rather than a directory walk: it honours `.gitignore` for
 * free, and a file git does not track is not one a CI run would execute.
 */
export async function findTestFiles(cwd: string, paths: string[] = []): Promise<string[]> {
  const args = ["ls-files", "-z", "--", ...(paths.length > 0 ? paths : ["."])];
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter((f) => f !== "" && isTestFile(f));
}
