import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractTests } from "../src/extract.ts";
import { detectFramework } from "../src/framework.ts";
import { buildFilter, fullName } from "../src/filter.ts";
import type { Selection, TestCase } from "../src/types.ts";

const HERE = new URL(".", import.meta.url).pathname;

async function load(rel: string): Promise<TestCase[]> {
  const file = join("test/fixtures", rel);
  const source = await readFile(join(HERE, "fixtures", rel), "utf8");
  return extractTests(source, file, detectFramework(source));
}

function sel(all: TestCase[], selected: TestCase[]): Selection {
  return {
    all,
    selected,
    verdicts: all.map((t, i) => ({
      id: `q${i}`,
      test: t,
      answer: null,
      reason: selected.includes(t) ? "scored" : "below",
      selected: selected.includes(t),
    })),
    fallback: null,
  };
}

test("the vitest pattern selects exactly the chosen tests under vitest's own spelling", async () => {
  const all = await load("vitest/cart.test.ts");
  assert.equal(all.length, 4);
  const selected = [all[0]!, all[3]!];
  const f = buildFilter(sel(all, selected), "vitest");
  assert.equal(f.mode, "pattern");
  const re = new RegExp(f.argv[1]!);
  // vitest joins a full name with " > ".
  for (const t of all) {
    assert.equal(re.test(t.titlePath.join(" > ")), selected.includes(t), fullName(t));
  }
});

test("the node:test pattern selects exactly the chosen tests under the space spelling", async () => {
  const all = await load("node/cart.test.cjs");
  assert.equal(all.length, 3);
  const selected = [all[1]!];
  const f = buildFilter(sel(all, selected), "node");
  assert.equal(f.argv.filter((a) => a === "--test-name-pattern").length, 1);
  const re = new RegExp(f.argv[1]!);
  // node:test joins a full name with a single space.
  for (const t of all) {
    assert.equal(re.test(t.titlePath.join(" ")), selected.includes(t), t.titlePath.join(" "));
  }
  // And it must not select a suite, which would run every test under it.
  assert.equal(re.test("Cart"), false);
  assert.equal(re.test("Cart applyDiscount"), false);
});

test("node:test really honours the generated filter, in a real process", async () => {
  const all = await load("node/cart.test.cjs");
  const f = buildFilter(sel(all, [all[1]!]), "node");
  assert.equal(f.mode, "pattern");

  // The only check in the suite that runs the runner. A pattern the runner
  // does not apply is invisible to every other test here: it produces a green
  // run of the WRONG tests. Node silently ignores `--test-name-pattern` when
  // it follows a positional, which is why `buildFilter` puts the flag first,
  // and this is what holds that ordering in place.
  //
  // NODE_TEST_CONTEXT has to go. Node's own test runner sets it in every test
  // file's environment, and a nested runner that sees it believes it is a
  // reporter child: it serialises its output down an IPC channel instead of
  // writing to the stdout pipe, so `res.stdout` comes back empty with a
  // status of 0. Every assertion below would then be reading "".
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const res = spawnSync(process.execPath, ["--test", ...f.argv], {
    cwd: join(HERE, ".."),
    encoding: "utf8",
    env,
  });

  assert.equal(res.status, 0, res.stderr);
  // Before the absences: an empty stdout satisfies every `doesNotMatch` below,
  // so a run that produced no output at all would otherwise read as a pass.
  assert.ok(res.stdout.length > 0, "the spawned runner wrote nothing to stdout");
  assert.match(res.stdout, /rounds half up/);
  assert.doesNotMatch(res.stdout, /clamps at zero/);
  assert.doesNotMatch(res.stdout, /totals/);
});

test("playwright is selected by location and every line points at a real test", async () => {
  const all = await load("playwright/login.spec.ts");
  assert.equal(all.length, 2);
  const f = buildFilter(sel(all, [all[0]!]), "playwright");
  assert.deepEqual(f.argv, ["test/fixtures/playwright/login.spec.ts:4"]);
  const source = await readFile(join(HERE, "fixtures/playwright/login.spec.ts"), "utf8");
  assert.match(source.split("\n")[all[0]!.line - 1]!, /test\("succeeds"/);
});
