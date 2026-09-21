import { test } from "node:test";
import assert from "node:assert/strict";
import { Lang } from "@ast-grep/napi";
import { detectFramework, isTestFile, langFor } from "../src/framework.ts";

test("detectFramework reads the import source", () => {
  assert.equal(detectFramework("import { it } from 'vitest';"), "vitest");
  assert.equal(detectFramework('import { test } from "node:test";'), "node");
  assert.equal(detectFramework("import { test } from '@playwright/test';"), "playwright");
  assert.equal(detectFramework("import { it } from '@jest/globals';"), "jest");
});

test("detectFramework handles require and re-exports", () => {
  assert.equal(detectFramework("const { test } = require('node:test');"), "node");
  assert.equal(detectFramework("export * from 'vitest';"), "vitest");
});

test("detectFramework returns unknown when nothing is imported", () => {
  assert.equal(detectFramework("describe('x', () => {});"), "unknown");
});

test("detectFramework prefers playwright when a file imports both", () => {
  const src = "import { test } from '@playwright/test';\nimport { expect } from 'vitest';";
  assert.equal(detectFramework(src), "playwright");
});

test("detectFramework ignores an import inside a string literal", () => {
  // This tool's own test files carry fixture sources as template literals. A
  // regular expression over the text reads those as real imports, which made
  // this repository look like it held Playwright specs it does not have.
  const src = [
    'import { test } from "node:test";',
    "const fixture = `",
    '  import { test } from "@playwright/test";',
    "`;",
  ].join("\n");
  assert.equal(detectFramework(src), "node");
});

test("langFor picks the grammar from the extension", () => {
  assert.equal(langFor("a.tsx"), Lang.Tsx);
  assert.equal(langFor("a.jsx"), Lang.Tsx);
  assert.equal(langFor("a.ts"), Lang.TypeScript);
  assert.equal(langFor("a.mts"), Lang.TypeScript);
  assert.equal(langFor("a.js"), Lang.JavaScript);
});

test("isTestFile accepts the usual spellings and rejects sources", () => {
  assert.equal(isTestFile("src/cart.test.ts"), true);
  assert.equal(isTestFile("e2e/login.spec.tsx"), true);
  assert.equal(isTestFile("test/a.test.mjs"), true);
  assert.equal(isTestFile("src/cart.ts"), false);
  assert.equal(isTestFile("src/testing.ts"), false);
});
