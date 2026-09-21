/**
 * Every test in the repository, whatever language it is written in.
 *
 * ECMAScript and Go come out of the source and cost a parse. Rust has to be
 * asked for: its names come from `cargo test -- --list`, which builds the test
 * targets, and a tool that triggers a compile nobody asked for is a tool that
 * gets removed from the workflow. `--format rust` is that asking.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectFramework, findTestFiles, isGoTestFile } from "./framework.ts";
import { extractTests } from "./extract.ts";
import { extractGoTests } from "./extract-go.ts";
import { listRustTests } from "./cargo.ts";
import type { Framework, TestCase } from "./types.ts";

export async function discoverTests(
  cwd: string,
  paths: string[],
  format: Framework | null,
): Promise<TestCase[]> {
  const out: TestCase[] = [];

  for (const file of await findTestFiles(cwd, paths)) {
    const source = await readFile(join(cwd, file), "utf8");
    if (isGoTestFile(file)) {
      if (format === null || format === "go") out.push(...extractGoTests(source, file));
      continue;
    }
    const framework = detectFramework(source, file);
    if (format !== null && framework !== format) continue;
    out.push(...extractTests(source, file, framework));
  }

  if (format === "rust") out.push(...(await listRustTests(cwd)));

  return out;
}
