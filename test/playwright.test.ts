import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaywrightList, attachPlaywrightRanges } from "../src/playwright.ts";
import { testId } from "../src/types.ts";

test("Playwright の一覧からプロジェクトと生成された各行を別テストとして取り出す", () => {
  const report = {
    config: { rootDir: "/repo/e2e" },
    suites: [{
      title: "rows.spec.ts", file: "rows.spec.ts", suites: [{
        title: "Cart", specs: [
          { title: "row alpha", file: "rows.spec.ts", line: 3, tests: [{ projectName: "chromium" }, { projectName: "firefox" }] },
          { title: "row beta", file: "rows.spec.ts", line: 3, tests: [{ projectName: "chromium" }, { projectName: "firefox" }] },
        ],
      }],
    }],
  };
  const tests = parsePlaywrightList(report, "/repo");
  assert.equal(tests.length, 4);
  assert.deepEqual(tests[0], {
    file: "e2e/rows.spec.ts", runnerFile: "rows.spec.ts", titlePath: ["Cart", "row alpha"],
    line: 3, endLine: 3, framework: "playwright", dynamic: false, project: "chromium",
  });
  assert.equal(new Set(tests.map(testId)).size, 4);
});

test("Playwright の設定外パスは一覧から受け入れない", () => {
  assert.throws(() => parsePlaywrightList({
    config: { rootDir: "/outside" }, suites: [{ file: "x.spec.ts", specs: [{ title: "x", file: "x.spec.ts", line: 1, tests: [{}] }] }],
  }, "/repo"), /outside/);
});

test("Playwright の一覧の開始行にソース解析の本体範囲を補う", () => {
  const listed = [{ file: "e2e/cart.spec.ts", runnerFile: "cart.spec.ts", titlePath: ["Cart", "total"],
    line: 3, endLine: 3, framework: "playwright" as const, dynamic: false, project: "chromium" }];
  const source = [{ file: "e2e/cart.spec.ts", titlePath: ["Cart", "total"], line: 3, endLine: 8,
    framework: "playwright" as const, dynamic: false }];
  assert.equal(attachPlaywrightRanges(listed, source)[0]?.endLine, 8);
});
