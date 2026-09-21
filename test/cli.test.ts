import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, renderLine, renderJson, execArgv } from "../src/cli.ts";
import type { RunResult } from "../src/run.ts";
import type { TestCase } from "../src/types.ts";

function mk(name: string, over: Partial<TestCase> = {}): TestCase {
  return { file: "a.test.ts", titlePath: [name], line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function result(argv: string[], mode: "all" | "none" | "files" | "pattern" | "locations"): RunResult {
  const t = mk("hot");
  return {
    selection: {
      verdicts: [{ id: "q0000", test: t, answer: { value: 3, confidence: 0.9 }, reason: "scored", selected: true }],
      selected: [t],
      all: [t, mk("cold", { line: 9 })],
      fallback: null,
    },
    framework: "vitest",
    filter: { mode, argv },
    record: { version: 1, createdAt: "", base: null, framework: "vitest", tests: [], touched: [], answers: {}, fallback: null },
    spent: null,
  };
}

test("parseCliArgs reads the flags and the paths", () => {
  const a = parseCliArgs(["--base", "main", "--cutoff", "1.5", "src", "e2e"]);
  assert.equal(a.base, "main");
  assert.equal(a.cutoff, 1.5);
  assert.deepEqual(a.paths, ["src", "e2e"]);
  assert.equal(a.json, false);
});

test("parseCliArgs splits the command after --exec", () => {
  const a = parseCliArgs(["--base", "main", "--exec", "--", "vitest", "run"]);
  assert.deepEqual(a.exec, ["vitest", "run"]);
  assert.deepEqual(a.paths, []);
});

test("parseCliArgs rejects an unknown format", () => {
  assert.throws(() => parseCliArgs(["--format", "mocha"]), /mocha/);
});

test("renderLine quotes an argument that needs it", () => {
  assert.equal(renderLine(result(["a.test.ts", "-t", "^(?:Cart > totals)$"], "pattern")), "a.test.ts -t '^(?:Cart > totals)$'");
});

test("renderLine is empty when everything is selected", () => {
  assert.equal(renderLine(result([], "all")), "");
});

test("execArgv appends the filter to the command", () => {
  assert.deepEqual(execArgv(["vitest", "run"], result(["a.test.ts"], "files")), ["vitest", "run", "a.test.ts"]);
});

test("execArgv refuses to run when nothing was selected", () => {
  assert.equal(execArgv(["vitest", "run"], result([], "none")), null);
});

test("renderJson reports every test with its reason", () => {
  const json = JSON.parse(renderJson(result(["a.test.ts"], "files"))) as Record<string, unknown>;
  assert.equal(json.framework, "vitest");
  assert.equal(json.mode, "files");
  assert.deepEqual(json.argv, ["a.test.ts"]);
  const tests = json.tests as Array<Record<string, unknown>>;
  assert.equal(tests.length, 1);
  assert.equal(tests[0]!.reason, "scored");
  assert.equal(tests[0]!.name, "hot");
});
