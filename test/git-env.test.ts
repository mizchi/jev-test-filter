import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "./git-env.ts";

// A git hook (pkf's pre-push runs this suite) exports GIT_DIR. A test that
// then runs `git init` in a temporary directory re-initialises the real
// repository instead and flips it to core.bare = true.
test("gitEnv drops the GIT_* variables a hook exports", () => {
  const env = gitEnv({ GIT_DIR: "/x/.git", GIT_WORK_TREE: "/x", GIT_INDEX_FILE: "/x/.git/index", PATH: "/bin", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("git init under gitEnv leaves the repository named by GIT_DIR alone", async () => {
  const outer = await mkdtemp(join(tmpdir(), "jev-outer-"));
  const inner = await mkdtemp(join(tmpdir(), "jev-inner-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: outer, env: gitEnv() });
    const before = await readFile(join(outer, ".git", "config"), "utf8");
    execFileSync("git", ["init", "-q"], { cwd: inner, env: gitEnv({ ...process.env, GIT_DIR: join(outer, ".git") }) });
    assert.equal(await readFile(join(outer, ".git", "config"), "utf8"), before);
  } finally {
    await rm(outer, { recursive: true, force: true });
    await rm(inner, { recursive: true, force: true });
  }
});
