import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContext, lookup, parseContext } from "../src/context.ts";
import { historySentence } from "../src/questions.ts";
import { replay, run } from "../src/run.ts";
import type { AskClient } from "../src/jev.ts";
import type { ScoreQuestion } from "../src/questions.ts";
import type { JevContext, TestCase } from "../src/types.ts";

const SAMPLE = {
  version: 1,
  digest: "sha256:abc",
  generated_at: "2026-09-24T00:00:00.000Z",
  gate: {
    cutoff: 2.0,
    unsure_below: 0.5,
    unsure_margin: 1.0,
    basis: { records: 42, real_failures: 17, recall_lb95: 0.83 },
  },
  skip: [{ file: "tests/a.test.ts", title_path: ["A", "b"], reason: "quarantined" }],
  tests: [
    { file: "tests/cli/init.test.ts", title_path: ["init", "writes toml"], failed_with: ["src/cli/config.ts"], missed: 2 },
  ],
};

function mk(file: string, titlePath: string[], over: Partial<TestCase> = {}): TestCase {
  return { file, titlePath, line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

test("parseContext accepts the v1 projection as flaker emits it", () => {
  const ctx = parseContext(SAMPLE);
  assert.equal(ctx.digest, "sha256:abc");
  assert.deepEqual(ctx.gate, SAMPLE.gate);
  assert.deepEqual(ctx.skip, SAMPLE.skip);
  assert.deepEqual(ctx.tests, SAMPLE.tests);
});

test("parseContext refuses any version but 1, and says which it got", () => {
  assert.throws(() => parseContext({ ...SAMPLE, version: 2 }), /context version 2.*expected 1/);
  assert.throws(() => parseContext({ ...SAMPLE, version: undefined }), /context version undefined/);
});

test("parseContext refuses a shape it would have to guess at", () => {
  assert.throws(() => parseContext(null), /context/);
  assert.throws(() => parseContext({ ...SAMPLE, digest: 1 }), /digest/);
  assert.throws(() => parseContext({ ...SAMPLE, gate: { cutoff: "2" } }), /gate\.cutoff/);
  assert.throws(() => parseContext({ ...SAMPLE, skip: [{ file: "a.ts" }] }), /skip\[0\]\.title_path/);
  assert.throws(() => parseContext({ ...SAMPLE, tests: [{ file: "a.ts", title_path: ["x"], failed_with: [1] }] }), /tests\[0\]\.failed_with/);
});

test("parseContext treats a missing gate, skip or tests as empty", () => {
  const ctx = parseContext({ version: 1, digest: "sha256:0" });
  assert.equal(ctx.gate, null);
  assert.deepEqual(ctx.skip, []);
  assert.deepEqual(ctx.tests, []);
});

test("loadContext reads a file, and names it when it cannot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-context-"));
  try {
    const path = join(dir, "context.json");
    writeFileSync(path, JSON.stringify(SAMPLE));
    assert.equal((await loadContext(path)).digest, "sha256:abc");
    writeFileSync(path, "{ not json");
    await assert.rejects(loadContext(path), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lookup matches on file and title path, never on the line", () => {
  const ctx = parseContext(SAMPLE);
  const moved = mk("tests/a.test.ts", ["A", "b"], { line: 400, endLine: 410 });
  assert.equal(lookup(ctx).skipped(moved), true);
  assert.equal(lookup(ctx).skipped(mk("tests/a.test.ts", ["A", "c"])), false);
  assert.deepEqual(lookup(ctx).failedWith(mk("tests/cli/init.test.ts", ["init", "writes toml"], { line: 77 })), ["src/cli/config.ts"]);
  assert.deepEqual(lookup(ctx).failedWith(moved), []);
});

test("lookup keys a Playwright entry by project when it names one", () => {
  const ctx = parseContext({
    ...SAMPLE,
    skip: [
      { file: "e2e/a.spec.ts", title_path: ["only firefox"], project: "firefox" },
      { file: "e2e/a.spec.ts", title_path: ["every browser"] },
    ],
  });
  const l = lookup(ctx);
  const pw = (title: string, project: string) => mk("e2e/a.spec.ts", [title], { framework: "playwright", project });
  assert.equal(l.skipped(pw("only firefox", "firefox")), true);
  assert.equal(l.skipped(pw("only firefox", "chromium")), false);
  // An entry without a project is about the test in every project.
  assert.equal(l.skipped(pw("every browser", "chromium")), true);
});

test("historySentence states the fact and nothing that reads as a threshold", () => {
  assert.equal(historySentence(["src/cli/config.ts"]), "This test previously failed when src/cli/config.ts changed.");
  assert.equal(historySentence(["a.ts", "b.ts"]), "This test previously failed when a.ts or b.ts changed.");
  assert.equal(historySentence(["a.ts", "b.ts", "c.ts"]), "This test previously failed when a.ts, b.ts or c.ts changed.");
});

// --- the run, end to end with a test double for Jev ---

const SOURCE = `import { describe, it } from "vitest";

describe("A", () => {
  it("b", () => {});
  it("c", () => {});
  it("d", () => {});
});
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A client that answers every question it is asked with one score, and keeps them. */
function recording(value: number, confidence = 0.9): AskClient & { asked: Record<string, ScoreQuestion> } {
  const asked: Record<string, ScoreQuestion> = {};
  return {
    asked,
    model: "jev-latest",
    servedModel: "jev-latest",
    spent: { calls: 1, inputTokens: 1, outputTokens: 0, ms: 1, retried: 0, rateLimited: 0, tokensPerSecond: 1, splits: 0, usd: 0 },
    askSplitting: async (_state, questions) => {
      Object.assign(asked, questions);
      return {
        answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { score: value, confidence }])),
        usage: { input_tokens: 1 },
      };
    },
  };
}

function withRepo(fn: (cwd: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "jev-context-run-"));
    try {
      git(cwd, "init", "-q");
      writeFileSync(join(cwd, "a.test.ts"), SOURCE);
      git(cwd, "add", ".");
      git(cwd, "commit", "-q", "-m", "one");
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

const CONTEXT: JevContext = {
  version: 1,
  digest: "sha256:ctx",
  generated_at: "2026-09-24T00:00:00.000Z",
  gate: { cutoff: 1.0, unsure_below: 0.5, unsure_margin: 1.0 },
  skip: [{ file: "a.test.ts", title_path: ["A", "b"], reason: "quarantined" }],
  tests: [{ file: "a.test.ts", title_path: ["A", "c"], failed_with: ["src/config.ts"], missed: 1 }],
};

test("a skipped test is not asked about and is reported as quarantined", withRepo(async (cwd) => {
  const client = recording(3);
  const res = await run({ cwd, client, context: CONTEXT });
  const b = res.selection.verdicts.find((v) => v.test.titlePath[1] === "b")!;
  assert.equal(b.reason, "quarantined");
  assert.equal(b.selected, false);
  assert.equal(b.answer, null);
  assert.equal(client.asked[b.id], undefined);
  assert.deepEqual(res.selection.selected.map((t) => t.titlePath[1]), ["c", "d"]);
  // Still part of the run, so a filter that selects "everything else" still
  // leaves it out rather than running it by omission.
  assert.equal(res.selection.all.length, 3);
  assert.notEqual(res.filter.mode, "all");
  assert.deepEqual(res.record.quarantined.length, 1);
}));

test("only the hinted test's question carries the hint", withRepo(async (cwd) => {
  const client = recording(3);
  await run({ cwd, client, context: CONTEXT });
  const bare = new Map<string, ScoreQuestion>();
  const byName = Object.values(client.asked).map((q) => [String(q.instructions.test_name), q] as const);
  for (const [name, q] of byName) bare.set(name, q);
  assert.equal(bare.get("A > c")!.instructions.history, "This test previously failed when src/config.ts changed.");
  assert.equal("history" in bare.get("A > d")!.instructions, false);
}));

test("the context's gate is the default and a flag still wins", withRepo(async (cwd) => {
  // Every answer is 1.5: selected at the context's cutoff of 1, not at 2.
  const fromContext = await run({ cwd, client: recording(1.5), context: CONTEXT });
  assert.deepEqual(fromContext.record.gate, { cutoff: 1, unsure_below: 0.5, unsure_margin: 1 });
  assert.equal(fromContext.selection.selected.length, 2);

  const flagged = await run({ cwd, client: recording(1.5), context: CONTEXT, cutoff: 2, unsureMargin: 0 });
  assert.deepEqual(flagged.record.gate, { cutoff: 2, unsure_below: 0.5, unsure_margin: 0 });
  assert.equal(flagged.selection.selected.length, 0);

  // An option given as undefined is not given: it must not erase the context's value.
  const undef = await run({ cwd, client: recording(1.5), context: CONTEXT, cutoff: undefined });
  assert.equal(undef.record.gate.cutoff, 1);
}));

test("the record keeps the context's digest, and a replay keeps the quarantine", withRepo(async (cwd) => {
  const res = await run({ cwd, client: recording(3), context: CONTEXT });
  assert.equal(res.record.context_digest, "sha256:ctx");
  const again = replay(res.record);
  assert.deepEqual(again.verdicts.map((v) => v.reason), res.selection.verdicts.map((v) => v.reason));
  assert.deepEqual(replay(res.record, { cutoff: 0 }).verdicts.find((v) => v.test.titlePath[1] === "b")!.reason, "quarantined");
}));

test("a run without a context has a null digest and asks every test", withRepo(async (cwd) => {
  const client = recording(3);
  const res = await run({ cwd, client });
  assert.equal(res.record.context_digest, null);
  assert.deepEqual(res.record.quarantined, []);
  assert.equal(Object.keys(client.asked).length, 3);
}));
