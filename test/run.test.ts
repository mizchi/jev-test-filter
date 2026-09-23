import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, score, replay, pickFramework, run } from "../src/run.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskClient } from "../src/jev.ts";
import { testId } from "../src/types.ts";
import type { TestCase } from "../src/types.ts";

function mk(file: string, path: string[], over: Partial<TestCase> = {}): TestCase {
  return { file, titlePath: path, line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function client(answers: Record<string, unknown>): AskClient {
  return {
    model: "jev-latest",
    servedModel: "jev-latest",
    spent: { calls: 1, inputTokens: 1, outputTokens: 0, ms: 1, retried: 0, rateLimited: 0, tokensPerSecond: 1, splits: 0, usd: 0 },
    askSplitting: async () => ({ answers, usage: { input_tokens: 1 } }),
  };
}

test("pickFramework returns the single framework present", () => {
  assert.equal(pickFramework([mk("a.test.ts", ["x"])]), "vitest");
});

test("pickFramework throws when the set is mixed", () => {
  const tests = [mk("a.test.ts", ["x"]), mk("e2e/a.spec.ts", ["y"], { framework: "playwright" })];
  assert.throws(() => pickFramework(tests), /vitest.*playwright|playwright.*vitest/);
});

test("pickFramework treats unknown as its own framework and still throws on a mix", () => {
  const tests = [mk("a.test.ts", ["x"]), mk("b.test.ts", ["y"], { framework: "unknown" })];
  assert.throws(() => pickFramework(tests), /--format/);
});

test("score asks one question per test and reads the answers back by index", async () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["cold"], { line: 9 })];
  const answers = await score(tests, { reviewing: "a git diff", changed_files: [], stat: "", diff: "", truncated: false, omitted_files: [] }, {
    client: client({ q0000: { score: 3, confidence: 0.9 }, q0001: { score: 0, confidence: 0.9 } }),
  });
  assert.deepEqual(answers.get("q0000"), { value: 3, confidence: 0.9 });
  assert.deepEqual(answers.get("q0001"), { value: 0, confidence: 0.9 });
});

test("score leaves an unanswered question null rather than inventing a zero", async () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["lost"], { line: 9 })];
  const answers = await score(tests, { reviewing: "a git diff", changed_files: [], stat: "", diff: "", truncated: false, omitted_files: [] }, {
    client: client({ q0000: { score: 3, confidence: 0.9 } }),
  });
  assert.equal(answers.get("q0001"), null);
});

test("collect pairs each test with whether the diff touched it", () => {
  const edited = mk("a.test.ts", ["edited"], { line: 10, endLine: 20 });
  const untouched = mk("a.test.ts", ["untouched"], { line: 40, endLine: 44 });
  const ranges = new Map([["a.test.ts", [[12, 13]] as Array<[number, number]>]]);
  // Which one, not how many: a `collect` that returned the wrong test would
  // satisfy a size check and quietly run the wrong half of the suite.
  assert.deepEqual([...collect([edited, untouched], ranges)], [testId(edited)]);
});

test("replay re-gates a record without a client", () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["mild"], { line: 9 })];
  const record = {
    version: 1 as const,
    createdAt: "2026-09-21T00:00:00.000Z",
    base: null,
    framework: "vitest" as const,
    tests,
    touched: [],
    answers: { q0000: { value: 3, confidence: 0.9 }, q0001: { value: 1.5, confidence: 0.9 } },
    fallback: null,
  };
  assert.deepEqual(replay(record, { cutoff: 2.0 }).selected.map((t) => t.titlePath[0]), ["hot"]);
  assert.deepEqual(replay(record, { cutoff: 1.0 }).selected.map((t) => t.titlePath[0]), ["hot", "mild"]);
});

test("Playwright の一覧取得に失敗したら絞り込まず全件を実行する", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-playwright-fallback-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd });
    const res = await run({ cwd, format: "playwright", playwrightCommand: ["/missing/playwright"], dryRun: true });
    assert.equal(res.filter.mode, "all");
    assert.match(res.selection.fallback!, /Playwright test listing failed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
