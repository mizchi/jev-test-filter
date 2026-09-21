import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFramework, isTestFile } from "../src/framework.ts";

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

test("isTestFile accepts the usual spellings and rejects sources", () => {
  assert.equal(isTestFile("src/cart.test.ts"), true);
  assert.equal(isTestFile("e2e/login.spec.tsx"), true);
  assert.equal(isTestFile("test/a.test.mjs"), true);
  assert.equal(isTestFile("src/cart.ts"), false);
  assert.equal(isTestFile("src/testing.ts"), false);
});
