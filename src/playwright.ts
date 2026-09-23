/** Playwright's collected tests, including generated rows and project variants. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { extractTests } from "./extract.ts";
import type { TestCase } from "./types.ts";

const execFileAsync = promisify(execFile);

interface ListedTest { projectName?: string }
interface ListedSpec { title?: string; file?: string; line?: number; tests?: ListedTest[] }
interface ListedSuite { title?: string; suites?: ListedSuite[]; specs?: ListedSpec[] }
interface ListedReport { config?: { rootDir?: string }; suites?: ListedSuite[]; errors?: unknown[] }

export function parsePlaywrightList(raw: unknown, cwd: string): TestCase[] {
  const report = raw as ListedReport;
  const rootDir = report?.config?.rootDir;
  if (typeof rootDir !== "string" || !Array.isArray(report.suites) || (report.errors?.length ?? 0) > 0) {
    throw new Error("invalid Playwright test list");
  }
  const out: TestCase[] = [];
  const walk = (suite: ListedSuite, chain: string[], root: boolean): void => {
    const titles = root ? chain : [...chain, suite.title ?? ""];
    for (const spec of suite.specs ?? []) {
      if (typeof spec.file !== "string" || typeof spec.title !== "string" || !Array.isArray(spec.tests)) {
        throw new Error("invalid Playwright spec");
      }
      const file = relative(cwd, resolve(rootDir, spec.file)).split(sep).join("/");
      if (file === ".." || file.startsWith("../") || file.startsWith("/")) {
        throw new Error(`Playwright test is outside the repository: ${file}`);
      }
      for (const variant of spec.tests) {
        out.push({
          file, runnerFile: spec.file.split(sep).join("/"), titlePath: [...titles, spec.title],
          line: spec.line ?? 0, endLine: spec.line ?? 0, framework: "playwright", dynamic: false,
          project: variant.projectName ?? "",
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, titles, false);
  };
  for (const suite of report.suites) walk(suite, [], true);
  return out;
}

export function attachPlaywrightRanges(listed: TestCase[], sourceCases: TestCase[]): TestCase[] {
  const ends = new Map<string, number>();
  for (const t of sourceCases) {
    const key = `${t.file}:${t.line}`;
    ends.set(key, Math.max(ends.get(key) ?? 0, t.endLine));
  }
  return listed.map((t) => ({ ...t, endLine: Math.max(t.endLine, ends.get(`${t.file}:${t.line}`) ?? t.endLine) }));
}

/** Collect without running browsers. The user's runner command preserves its config and project flags. */
export async function listPlaywrightTests(cwd: string, command: string[]): Promise<TestCase[]> {
  if (command.length === 0) throw new Error("a Playwright command is required");
  const { stdout } = await execFileAsync(command[0]!, [...command.slice(1), "--list", "--reporter=json"], {
    cwd, maxBuffer: 128 * 1024 * 1024,
  });
  const listed = parsePlaywrightList(JSON.parse(stdout), cwd);
  const sourceCases: TestCase[] = [];
  for (const file of new Set(listed.map((t) => t.file))) {
    try {
      sourceCases.push(...extractTests(await readFile(resolve(cwd, file), "utf8"), file, "playwright"));
    } catch {
      // The runner's inventory is authoritative; a source parse only adds
      // end lines for touched-test detection and must not hide listed tests.
    }
  }
  return attachPlaywrightRanges(listed, sourceCases);
}
