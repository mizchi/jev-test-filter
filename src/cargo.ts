/**
 * Rust's tests: names from cargo, locations from the source.
 *
 * `cargo test -- --exact` is unforgiving. A module path reconstructed one
 * segment wrong matches nothing, the run is green, and nothing says a test was
 * skipped -- so the names that reach the filter are the ones cargo printed,
 * never ones this tool assembled. Cargo has to build the test targets to list
 * them, which is work a run would do anyway.
 *
 * The source still has something cargo's listing does not: where each test
 * is. Matching the two by full path gives a file and a line, which is what
 * lets a test whose own body sits in the diff be selected without being
 * asked about. A name cargo listed and no `#[test]` function accounts for --
 * anything a macro generated -- keeps no location and is scored instead.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "@ast-grep/napi";
import { registerLanguages } from "./languages.ts";
import type { TestCase } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Where a test is. */
export interface Location {
  file: string;
  line: number;
  endLine: number;
}

/** `#[test]`, `#[tokio::test]`, `#[async_std::test]` -- but not `#[cfg(test)]`. */
const TEST_ATTRIBUTE = /^#\[\s*(?:[A-Za-z_]\w*\s*::\s*)*test\s*\]$/;

export function isTestAttribute(text: string): boolean {
  return TEST_ATTRIBUTE.test(text);
}

/** The `name: test` lines of `cargo test -- --list`, without the suffix. */
export function parseCargoList(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+): test$/.exec(line.trim());
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * The module path a file contributes, by Rust's file-to-module rules.
 *
 * `src/lib.rs` and `src/main.rs` are crate roots and contribute nothing;
 * `mod.rs` names its directory; every file under `tests/`, `benches/` and
 * `examples/` is its own crate root. A `#[path]` attribute can override all of
 * this, and is rare enough that a name it moves simply goes unlocated.
 */
export function modulePrefix(file: string): string[] {
  const m = /^(src|tests|benches|examples)\/(.+)\.rs$/.exec(file);
  if (!m) return [];
  if (m[1] !== "src") return [];
  const parts = m[2]!.split("/");
  const last = parts.at(-1)!;
  if (last === "lib" || last === "main" || last === "mod") parts.pop();
  return parts;
}

/** Every `#[test]` function in one file, keyed by its full module path. */
export function rustTestsIn(source: string, file: string): Map<string, Location> {
  registerLanguages();
  const root = parse("rust", source).root();
  const out = new Map<string, Location>();

  const mods = root.findAll({ rule: { kind: "mod_item" } as never }).map((n) => ({
    name: n.field("name")?.text() ?? "",
    start: n.range().start.index,
    end: n.range().end.index,
  }));

  for (const fn of root.findAll({ rule: { kind: "function_item" } as never })) {
    // Attributes are siblings preceding the item, nearest last.
    let isTest = false;
    for (const prev of fn.prevAll()) {
      if (prev.kind() !== "attribute_item") break;
      if (isTestAttribute(prev.text())) isTest = true;
    }
    if (!isTest) continue;

    const range = fn.range();
    const chain = mods
      .filter((m) => m.start <= range.start.index && m.end >= range.end.index)
      .sort((a, b) => a.start - b.start)
      .map((m) => m.name);

    const path = [...modulePrefix(file), ...chain, fn.field("name")?.text() ?? ""].join("::");
    out.set(path, { file, line: range.start.line + 1, endLine: range.end.line + 1 });
  }
  return out;
}

/** `git ls-files` for the crate's Rust sources. */
async function rustFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", "*.rs"], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((f) => f !== "");
}

/**
 * Ask cargo what tests exist. This builds the test targets.
 *
 * `--quiet` keeps cargo's own progress off stdout; the listing is what is
 * left. A failure to build is not something to work around -- it is reported
 * so the run can fall back to everything.
 */
export async function cargoList(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("cargo", ["test", "--quiet", "--", "--list"], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function listRustTests(cwd: string): Promise<TestCase[]> {
  const names = parseCargoList(await cargoList(cwd));

  const located = new Map<string, Location>();
  for (const file of await rustFiles(cwd)) {
    const source = await readFile(join(cwd, file), "utf8");
    for (const [path, at] of rustTestsIn(source, file)) located.set(path, at);
  }

  return names.map((name) => {
    const at = located.get(name);
    return {
      file: at?.file ?? "",
      titlePath: name.split("::"),
      line: at?.line ?? 0,
      endLine: at?.endLine ?? 0,
      framework: "rust" as const,
      dynamic: false,
    };
  });
}
