import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseCliArgs, renderLine, renderJson, renderSnapshotReport, execArgv, materializeFilter, shouldSaveRecord, stdoutExitCode, DEFAULT_RECORD_PATH } from "../src/cli.ts";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "../src/run.ts";
import type { TestCase } from "../src/types.ts";

function mk(name: string, over: Partial<TestCase> = {}): TestCase {
  return { file: "a.test.ts", titlePath: [name], line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function result(argv: string[], mode: "all" | "none" | "files" | "pattern" | "locations" | "test-list"): RunResult {
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

test("npm の bin symlink 経由でも CLI 本体として起動する", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-cli-bin-"));
  try {
    const source = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const bin = join(cwd, "jev-test-filter");
    await symlink(source, bin);
    const res = spawnSync(process.execPath, [bin, "--help"], { cwd, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /jev-test-filter/);
    assert.match(res.stdout, /--exec/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("parseCliArgs rejects an unknown format", () => {
  assert.throws(() => parseCliArgs(["--format", "mocha"]), /mocha/);
});

test("parseCliArgs accepts bun as a test runner", () => {
  assert.equal(parseCliArgs(["--format", "bun"]).format, "bun");
});

test("スナップショット確認モードはテスト実行と混ぜない", () => {
  assert.equal(parseCliArgs(["--verify-snapshots"]).verifySnapshots, true);
  assert.throws(() => parseCliArgs(["--verify-snapshots", "--exec", "--", "vitest", "run"]), /cannot be combined/);
});

test("スナップショット確認結果を簡潔に表示する", () => {
  assert.equal(renderSnapshotReport({
    entries: [{ file: "src/__snapshots__/cart.test.ts.snap", kind: "external", status: "review", score: 2, confidence: 0.9 }],
    error: null, spent: null,
  }), "review\tsrc/__snapshots__/cart.test.ts.snap\texternal\tscore=2\tconfidence=0.9\n");
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

test("Playwright の選択一覧を実行前に書き出す", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-playwright-"));
  try {
    const res = result(["--test-list", ".jev-test-filter/playwright-a.txt"], "test-list");
    res.filter.testList = ["[chromium] > rows.spec.ts > Cart > row alpha"];
    await materializeFilter(res, cwd);
    assert.equal(await readFile(join(cwd, res.filter.argv[1]!), "utf8"), "[chromium] > rows.spec.ts > Cart > row alpha\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the stdout form signals that nothing was selected", () => {
  // An empty argv means "run everything" and an empty argv also means "run
  // nothing", and stdout cannot tell a shell which. The status can.
  assert.equal(stdoutExitCode(result([], "none")), 3);
  assert.equal(stdoutExitCode(result([], "all")), 0);
  assert.equal(stdoutExitCode(result(["a.test.ts"], "files")), 0);
});

test("a fallback run does not overwrite the replay record", () => {
  const good = {
    version: 1 as const, createdAt: "", base: null, framework: "vitest" as const,
    tests: [], touched: [], answers: {}, fallback: null,
  };
  assert.equal(shouldSaveRecord(good), true);
  assert.equal(shouldSaveRecord({ ...good, fallback: "jev failed: HTTP 529" }), false);
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

test("a bare --replay means the record the last run left", () => {
  assert.equal(parseCliArgs(["--replay"]).replayPath, DEFAULT_RECORD_PATH);
  assert.equal(parseCliArgs(["--replay", "--cutoff", "1"]).replayPath, DEFAULT_RECORD_PATH);
});

test("--replay still takes an explicit path either way round", () => {
  assert.equal(parseCliArgs(["--replay", "old.json"]).replayPath, "old.json");
  assert.equal(parseCliArgs(["--replay=old.json"]).replayPath, "old.json");
});
