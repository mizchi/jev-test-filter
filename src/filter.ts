/**
 * A selection, as the runner's own arguments.
 *
 * Three shapes, one per framework family, and the differences between them
 * were measured rather than assumed:
 *
 *   - Vitest joins a full name with `" > "`; node:test joins it with a single
 *     space. A pattern in the wrong spelling selects nothing and says nothing.
 *   - node:test ORs repeated `--test-name-pattern` flags, and a pattern that
 *     matches a SUITE name runs every test under it. One flag, one
 *     alternation of anchored full names, is the only safe shape.
 *   - Playwright's `--grep` matches `"<project> <file> <chain> <title>"`, so an
 *     anchored pattern would have to know the project name and would break
 *     when a project is added. `file:line` is exact and needs no escaping.
 */
import type { Framework, Selection, TestCase } from "./types.ts";

export type FilterMode =
  /** Everything was selected: pass no arguments and let the runner run. */
  | "all"
  /** Nothing was selected: there is nothing to run. */
  | "none"
  /** Whole files, because a name pattern cannot express the selection. */
  | "files"
  /** Files plus an anchored alternation of full names. */
  | "pattern"
  /** `file:line` positionals. */
  | "locations"
  /** Exact names, for a runner that does not take a pattern. */
  | "exact";

export interface FilterArgs {
  mode: FilterMode;
  /** Arguments to append to the runner command, in order. */
  argv: string[];
}

export interface FilterOptions {
  /**
   * Above this fraction of the suite, the name pattern is dropped and whole
   * files are selected instead. A run that keeps most of the suite gains
   * nothing from an alternation of a thousand names.
   */
  fileThreshold?: number;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The full name as this test's own runner spells it. */
export function fullName(t: TestCase): string {
  if (t.framework === "rust") return t.titlePath.join("::");
  if (t.framework === "go") return t.titlePath.join("/");
  const sep = t.framework === "node" ? " " : " > ";
  return t.titlePath.join(sep);
}

/** The flag that carries a name pattern, per framework. */
function patternFlag(framework: Framework): string | null {
  if (framework === "node") return "--test-name-pattern";
  if (framework === "vitest" || framework === "jest") return "-t";
  return null;
}

function uniqueFiles(tests: TestCase[]): string[] {
  return [...new Set(tests.map((t) => t.file))];
}

/** `./pkg` for each directory a selected Go test lives in. */
function goPackages(tests: TestCase[]): string[] {
  const dirs = tests.map((t) => {
    const at = t.file.lastIndexOf("/");
    return at === -1 ? "./" : `./${t.file.slice(0, at)}`;
  });
  return [...new Set(dirs)].sort();
}

export function buildFilter(sel: Selection, framework: Framework, { fileThreshold = 0.8 }: FilterOptions = {}): FilterArgs {
  const { selected, all } = sel;
  // Both of these come before the per-framework dispatch on purpose. When
  // every test is selected, no arguments is not merely shorter than naming
  // them all -- it is the same run, and for Playwright it is the difference
  // between one command and one argument per test. When none is selected
  // there is nothing any framework could be asked to run.
  if (selected.length === 0) return { mode: "none", argv: [] };
  if (selected.length === all.length) return { mode: "all", argv: [] };

  if (framework === "playwright") {
    return { mode: "locations", argv: selected.map((t) => `${t.file}:${t.line}`) };
  }

  if (framework === "rust") {
    // `--exact` takes several names in one invocation, and every name came
    // from cargo's own listing rather than from a path this tool assembled --
    // a module path one segment wrong selects nothing and says nothing.
    // Targets are not narrowed: a name that exists in two of them runs in
    // both, which costs time and cannot lose a test.
    return { mode: "exact", argv: ["--", "--exact", ...selected.map(fullName)] };
  }

  if (framework === "go") {
    // Top-level functions, never subtests. `-run` takes one hierarchical
    // pattern and a second `-run` replaces the first, so "all of TestA, but
    // only x and y of TestB" cannot be said; the shape that covers TestB
    // would silently drop TestA's other subtests. Scoring stays per subtest,
    // which is what `--json` reports.
    const parents = [...new Set(selected.map((t) => t.titlePath[0] ?? ""))];
    const pattern = `^(?:${parents.map(escapeRegExp).join("|")})$`;
    return { mode: "pattern", argv: ["-run", pattern, ...goPackages(selected)] };
  }

  const files = uniqueFiles(selected);
  const flag = patternFlag(framework);
  // A dynamic test has no name a pattern can hold, and a pattern applies to
  // the whole run rather than to one file -- so one of them costs the run its
  // name-level filtering. Files are still a large saving.
  const hasDynamic = selected.some((t) => t.dynamic);
  const rate = selected.length / all.length;
  if (!flag || hasDynamic || rate > fileThreshold) {
    return { mode: "files", argv: files };
  }

  const names = [...new Set(selected.map(fullName))];
  const pattern = `^(?:${names.map(escapeRegExp).join("|")})$`;
  // The flag goes BEFORE the files, and that is not a style choice. Node's
  // test runner silently ignores `--test-name-pattern` when it follows a
  // positional: `node --test a.test.js --test-name-pattern X` runs the whole
  // file and exits 0. Vitest accepts either order, so one order serves both.
  return { mode: "pattern", argv: [flag, pattern, ...files] };
}
