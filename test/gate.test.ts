import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, gateOptions, resolveGate, DEFAULT_CUTOFF } from "../src/gate.ts";
import { testId } from "../src/types.ts";
import type { Answer, TestCase } from "../src/types.ts";

function mk(name: string, over: Partial<TestCase> = {}): TestCase {
  return { file: "a.test.ts", titlePath: [name], line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function answers(...values: Array<Answer | null>): Map<string, Answer | null> {
  const m = new Map<string, Answer | null>();
  values.forEach((a, i) => m.set(`q${String(i).padStart(4, "0")}`, a));
  return m;
}

test("a score at the cutoff is selected and one under it is not", () => {
  const tests = [mk("hot"), mk("cold")];
  const sel = gate(tests, answers({ value: DEFAULT_CUTOFF, confidence: 0.9 }, { value: 1.4, confidence: 0.9 }), new Set());
  assert.deepEqual(sel.verdicts.map((v) => v.selected), [true, false]);
  assert.deepEqual(sel.verdicts.map((v) => v.reason), ["scored", "below"]);
});

test("an unsure answer near the cutoff is selected to be safe", () => {
  const sel = gate([mk("maybe")], answers({ value: 1.2, confidence: 0.3 }), new Set());
  assert.equal(sel.verdicts[0]!.selected, true);
  assert.equal(sel.verdicts[0]!.reason, "unsure");
});

test("an unsure answer far under the cutoff is still not selected", () => {
  const sel = gate([mk("cold")], answers({ value: 0.2, confidence: 0.1 }), new Set());
  assert.equal(sel.verdicts[0]!.selected, false);
});

test("a confident answer under the cutoff is not rescued", () => {
  const sel = gate([mk("cold")], answers({ value: 1.2, confidence: 0.95 }), new Set());
  assert.equal(sel.verdicts[0]!.selected, false);
});

test("a missing answer is selected, not treated as a pass", () => {
  const sel = gate([mk("lost")], answers(null), new Set());
  assert.equal(sel.verdicts[0]!.selected, true);
  assert.equal(sel.verdicts[0]!.reason, "missing");
});

test("a touched test is selected without consulting its answer", () => {
  const t = mk("edited");
  const sel = gate([t], answers({ value: 0, confidence: 0.99 }), new Set([testId(t)]));
  assert.equal(sel.verdicts[0]!.selected, true);
  assert.equal(sel.verdicts[0]!.reason, "touched");
});

test("a dynamic test is always selected", () => {
  const sel = gate([mk("each", { dynamic: true })], answers({ value: 0, confidence: 0.99 }), new Set());
  assert.equal(sel.verdicts[0]!.reason, "dynamic");
  assert.equal(sel.verdicts[0]!.selected, true);
});

test("the cutoff is overridable and changes nothing else", () => {
  const sel = gate([mk("mild")], answers({ value: 1.5, confidence: 0.9 }), new Set(), { cutoff: 1.0 });
  assert.equal(sel.verdicts[0]!.selected, true);
  assert.equal(sel.verdicts[0]!.reason, "scored");
});

test("selected mirrors the verdicts and fallback starts null", () => {
  const tests = [mk("a"), mk("b")];
  const sel = gate(tests, answers({ value: 3, confidence: 0.9 }, { value: 0, confidence: 0.9 }), new Set());
  assert.deepEqual(sel.selected.map((t) => t.titlePath[0]), ["a"]);
  assert.equal(sel.all.length, 2);
  assert.equal(sel.fallback, null);
});

test("resolveGate fills what was not given with the defaults", () => {
  assert.deepEqual(resolveGate({}), { cutoff: 2, unsure_below: 0.5, unsure_margin: 1 });
  assert.deepEqual(resolveGate({ unsureMargin: 0 }), { cutoff: 2, unsure_below: 0.5, unsure_margin: 0 });
});

test("gateOptions reads a recorded gate back, and nothing from no gate", () => {
  assert.deepEqual(gateOptions({ cutoff: 1, unsure_below: 0.2, unsure_margin: 0.5 }), { cutoff: 1, unsureBelow: 0.2, unsureMargin: 0.5 });
  assert.deepEqual(gateOptions(null), {});
});

test("a quarantined test is not selected, whatever else is true of it", () => {
  const q = mk("flaky");
  const edited = mk("flaky and edited", { line: 5 });
  const tests = [q, edited, mk("kept", { line: 9 })];
  const sel = gate(
    tests,
    answers(null, { value: 3, confidence: 0.9 }, { value: 3, confidence: 0.9 }),
    new Set([testId(edited)]),
    {},
    new Set([testId(q), testId(edited)]),
  );
  assert.deepEqual(sel.verdicts.map((v) => v.reason), ["quarantined", "quarantined", "scored"]);
  assert.deepEqual(sel.verdicts.map((v) => v.selected), [false, false, true]);
  assert.deepEqual(sel.selected.map((t) => t.titlePath[0]), ["kept"]);
});
