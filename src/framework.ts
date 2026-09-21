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
import type { Framework } from "./types.ts";

const execFileAsync = promisify(execFile);

/** `foo.test.ts`, `foo.spec.tsx`, `foo.test.mjs`, and the rest of the family. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

/**
 * Every module specifier the file imports or requires.
 *
 * A regular expression rather than a parse: the extractor already parses the
 * file, but it does so per language and after this decision has been made,
 * and the specifier of an import is one of the few things in JavaScript a
 * regular expression reads correctly.
 */
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

/**
 * Playwright wins a tie because a spec that imports `expect` from elsewhere
 * is still a Playwright spec, and selecting a Playwright test by name is the
 * one thing that does not work.
 */
export function detectFramework(source: string): Framework {
  let vitest = false;
  let node = false;
  let jest = false;
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1]!;
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
