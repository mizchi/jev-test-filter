import { test } from "node:test";
import assert from "node:assert/strict";
import { findSnapshotChanges, assessSnapshots, snapshotTestFile, loadSnapshotTestSources } from "../src/snapshot.ts";
import { findSnapshotChangesInWorktree } from "../src/snapshot.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AskClient } from "../src/jev.ts";
import { gitEnv } from "./git-env.ts";

const DIFF = [
  "diff --git a/src/cart.test.ts b/src/cart.test.ts",
  "--- a/src/cart.test.ts", "+++ b/src/cart.test.ts", "@@ -1 +1 @@",
  "-expect(total).toMatchInlineSnapshot(`1`)", "+expect(total).toMatchInlineSnapshot(`2`)",
  "diff --git a/src/__snapshots__/cart.test.ts.snap b/src/__snapshots__/cart.test.ts.snap",
  "--- a/src/__snapshots__/cart.test.ts.snap", "+++ b/src/__snapshots__/cart.test.ts.snap", "@@ -1 +1 @@",
  "-exports[`cart 1`] = `1`", "+exports[`cart 1`] = `2`",
  "diff --git a/src/__snapshots__/cart.png b/src/__snapshots__/cart.png",
  "--- a/src/__snapshots__/cart.png", "+++ b/src/__snapshots__/cart.png", "@@ -1 +1 @@", "-binary", "+binary",
].join("\n");

function client(answers: Record<string, unknown>): AskClient {
  return {
    model: "jev-latest", servedModel: "jev-latest",
    spent: { calls: 1, inputTokens: 1, outputTokens: 0, ms: 1, retried: 0, rateLimited: 0, tokensPerSecond: 1, splits: 0, usd: 0 },
    askSplitting: async (_state, questions) => {
      assert.deepEqual(Object.keys(questions), ["q0000", "q0001"]);
      return { answers };
    },
  };
}

test("テキスト snap と inline snapshot の変更だけを見つける", () => {
  assert.deepEqual(findSnapshotChanges(DIFF), [
    { file: "src/cart.test.ts", kind: "inline" },
    { file: "src/__snapshots__/cart.test.ts.snap", kind: "external" },
  ]);
});

test("スナップショット更新のリスクと確信度をファイルごとに報告する", async () => {
  const result = await assessSnapshots(DIFF, "", client({
    q0000: { score: 0.2, confidence: 0.95 },
    q0001: { score: 2.6, confidence: 0.88 },
  }));
  assert.deepEqual(result.entries.map((e) => [e.file, e.status]), [
    ["src/cart.test.ts", "plausible"],
    ["src/__snapshots__/cart.test.ts.snap", "review"],
  ]);
  assert.equal(result.entries[1]?.score, 2.6);
});

test("確信度不足と応答欠落は要確認にする", async () => {
  const result = await assessSnapshots(DIFF, "", client({
    q0000: { score: 0, confidence: 0.1 },
  }));
  assert.deepEqual(result.entries.map((e) => e.status), ["review", "unknown"]);
});

test("画像しか変わらなければ Jev を呼ばない", async () => {
  const diff = DIFF.slice(DIFF.indexOf("diff --git a/src/__snapshots__/cart.png"));
  const result = await assessSnapshots(diff, "", client({}));
  assert.deepEqual(result.entries, []);
});

test("複数行 inline snapshot の値だけが変わった場合も見つける", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-inline-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/cart.test.ts"), [
      "import { test, expect } from 'vitest';",
      "test('cart', () => {",
      "  expect({ total: 2 }).toMatchInlineSnapshot(`{",
      "    total: 2,",
      "  }`);",
      "});",
    ].join("\n"));
    const diff = [
      "diff --git a/src/cart.test.ts b/src/cart.test.ts", "--- a/src/cart.test.ts", "+++ b/src/cart.test.ts",
      "@@ -4 +4 @@", "-    total: 1,", "+    total: 2,",
    ].join("\n");
    assert.deepEqual(await findSnapshotChangesInWorktree(diff, cwd), [{ file: "src/cart.test.ts", kind: "inline" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("外部スナップショットから対応するテスト本体を読み込む", async () => {
  assert.equal(snapshotTestFile({ file: "src/__snapshots__/cart.test.ts.snap", kind: "external" }), "src/cart.test.ts");
  const cwd = await mkdtemp(join(tmpdir(), "jev-snapshot-source-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/cart.test.ts"), "test('double', () => expect(double(2)).toMatchSnapshot());\n");
    const context = await loadSnapshotTestSources(cwd, [{ file: "src/__snapshots__/cart.test.ts.snap", kind: "external" }]);
    assert.match(context.sources["src/cart.test.ts"]!, /double\(2\)/);
    assert.deepEqual(context.omitted, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("コミット差分では作業ツリーではなく HEAD のテスト本体を読む", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-snapshot-revision-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd, env: gitEnv(), env: gitEnv() });
    await mkdir(join(cwd, "src"));
    const file = join(cwd, "src/cart.test.ts");
    await writeFile(file, "test('cart', () => double(2));\n");
    execFileSync("git", ["add", "."], { cwd, env: gitEnv(), env: gitEnv() });
    execFileSync("git", ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", "commit", "-qm", "baseline"], { cwd, env: gitEnv(), env: gitEnv() });
    await writeFile(file, "test('cart', () => double(99));\n");
    const changes = [{ file: "src/__snapshots__/cart.test.ts.snap", kind: "external" as const }];
    assert.match((await loadSnapshotTestSources(cwd, changes, 24_000, "HEAD")).sources["src/cart.test.ts"]!, /double\(2\)/);
    assert.match((await loadSnapshotTestSources(cwd, changes)).sources["src/cart.test.ts"]!, /double\(99\)/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
