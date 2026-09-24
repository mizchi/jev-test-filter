import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecord, replay, run, saveRecord, RECORD_DIR, RECORD_FILE, RECORDS_SUBDIR } from "../src/run.ts";
import type { AskClient } from "../src/jev.ts";
import type { RunRecordV1, RunRecordV2, TestCase } from "../src/types.ts";
import { gitEnv } from "./git-env.ts";

function mk(name: string, over: Partial<TestCase> = {}): TestCase {
  return { file: "a.test.ts", titlePath: [name], line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

/** Every question answered with the same score, like a model that shrugs. */
function flat(value: number, confidence = 0.9): AskClient {
  return {
    model: "jev-latest",
    servedModel: "jev-latest",
    spent: { calls: 1, inputTokens: 1, outputTokens: 0, ms: 1, retried: 0, rateLimited: 0, tokensPerSecond: 1, splits: 0, usd: 0 },
    askSplitting: async (_state, questions) => ({
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { score: value, confidence }])),
      usage: { input_tokens: 1 },
    }),
  };
}

const CART = `import { describe, it, test } from "vitest";

describe("Cart", () => {
  it("clamps at zero", () => {});
  test("totals", () => {});
});
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", ...args], { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

/** Two commits, so `--base HEAD~1` has somewhere to point. */
function repo(): { cwd: string; head: string; parent: string; done: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "jev-record-"));
  git(cwd, "init", "-q");
  writeFileSync(join(cwd, "cart.test.ts"), CART);
  writeFileSync(join(cwd, "cart.ts"), "export const a = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "one");
  writeFileSync(join(cwd, "cart.ts"), "export const a = 2;\n");
  git(cwd, "commit", "-q", "-am", "two");
  return {
    cwd,
    head: git(cwd, "rev-parse", "HEAD"),
    parent: git(cwd, "rev-parse", "HEAD~1"),
    done: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function v1(over: Partial<RunRecordV1> = {}): RunRecordV1 {
  return {
    version: 1,
    createdAt: "2026-09-21T00:00:00.000Z",
    base: null,
    framework: "vitest",
    tests: [mk("hot"), mk("mild", { line: 9 })],
    touched: [],
    answers: { q0000: { value: 3, confidence: 0.9 }, q0001: { value: 1.5, confidence: 0.9 } },
    fallback: null,
    ...over,
  };
}

test("a run records the commit it judged and the gate it used", async () => {
  const r = repo();
  try {
    const res = await run({ cwd: r.cwd, client: flat(3) });
    const rec = res.record;
    assert.equal(rec.version, 2);
    assert.equal(rec.head_sha, r.head);
    assert.equal(rec.base_sha, null);
    assert.equal(rec.context_digest, null);
    assert.deepEqual(rec.gate, { cutoff: 2, unsure_below: 0.5, unsure_margin: 1 });
  } finally {
    r.done();
  }
});

test("a run resolves --base to the sha it named", async () => {
  const r = repo();
  try {
    const res = await run({ cwd: r.cwd, base: "HEAD~1", client: flat(3), cutoff: 1.5, unsureMargin: 0 });
    assert.equal(res.record.base, "HEAD~1");
    assert.equal(res.record.base_sha, r.parent);
    // The values actually used: the flags where given, the defaults elsewhere.
    assert.deepEqual(res.record.gate, { cutoff: 1.5, unsure_below: 0.5, unsure_margin: 0 });
  } finally {
    r.done();
  }
});

test("head_sha is null outside a repository with a commit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-record-nohead-"));
  try {
    git(cwd, "init", "-q");
    // No commit: `git diff HEAD` itself fails here, so drive the record path
    // through saveRecord with a record whose head is unknown instead.
    const rec: RunRecordV2 = {
      ...v1(), version: 2, head_sha: null, base_sha: null, context_digest: null,
      gate: { cutoff: 2, unsure_below: 0.5, unsure_margin: 1 }, quarantined: [],
    };
    const paths = await saveRecord(cwd, rec);
    assert.deepEqual(paths, [join(cwd, RECORD_DIR, RECORD_FILE)]);
    assert.equal(existsSync(join(cwd, RECORD_DIR, RECORDS_SUBDIR)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("saveRecord writes last.json and a record per head sha", async () => {
  const r = repo();
  try {
    const res = await run({ cwd: r.cwd, client: flat(3) });
    const paths = await saveRecord(r.cwd, res.record);
    const perSha = join(r.cwd, RECORD_DIR, RECORDS_SUBDIR, `${r.head}.json`);
    assert.deepEqual(paths, [join(r.cwd, RECORD_DIR, RECORD_FILE), perSha]);
    assert.equal(readFileSync(perSha, "utf8"), readFileSync(paths[0]!, "utf8"));
    assert.deepEqual(await loadRecord(perSha), res.record);
  } finally {
    r.done();
  }
});

test("loadRecord reads a version 1 record, with the new fields null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-record-v1-"));
  try {
    const path = join(dir, "last.json");
    writeFileSync(path, JSON.stringify(v1()));
    const rec = await loadRecord(path);
    assert.equal(rec.version, 1);
    assert.equal(rec.head_sha, null);
    assert.equal(rec.base_sha, null);
    assert.equal(rec.context_digest, null);
    assert.equal(rec.gate, null);
    assert.deepEqual(rec.quarantined, []);
    assert.deepEqual(rec.answers, v1().answers);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRecord refuses a version it does not know", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-record-v9-"));
  try {
    const path = join(dir, "last.json");
    writeFileSync(path, JSON.stringify({ ...v1(), version: 9 }));
    await assert.rejects(loadRecord(path), /unsupported record version 9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay re-gates under the record's own gate unless told otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-record-gate-"));
  try {
    const path = join(dir, "r.json");
    // Recorded at cutoff 1: both tests were selected then.
    writeFileSync(path, JSON.stringify({
      ...v1(), version: 2, head_sha: "abc", base_sha: null, context_digest: null,
      gate: { cutoff: 1, unsure_below: 0.5, unsure_margin: 1 }, quarantined: [],
    }));
    const rec = await loadRecord(path);
    assert.deepEqual(replay(rec).selected.map((t) => t.titlePath[0]), ["hot", "mild"]);
    assert.deepEqual(replay(rec, { cutoff: 2 }).selected.map((t) => t.titlePath[0]), ["hot"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay of a version 1 record falls back to the gate's defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-record-v1gate-"));
  try {
    const path = join(dir, "r.json");
    writeFileSync(path, JSON.stringify(v1()));
    assert.deepEqual(replay(await loadRecord(path)).selected.map((t) => t.titlePath[0]), ["hot"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
