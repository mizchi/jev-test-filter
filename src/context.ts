/**
 * What flaker knows, read in: `--context <file>`.
 *
 * flaker keeps the history this tool has no way to see -- which tests are
 * quarantined, which tests failed the last time a given file changed, which
 * gate values its calibration settled on -- and projects it into one JSON
 * file, `jev-context` v1. This module reads that file and answers the two
 * questions a run asks of it, per test: is it skipped, and what has it failed
 * with before.
 *
 * The gate is NOT decided here. The context only supplies default values;
 * `gate.ts` is still the one place a score becomes a selection, so flaker
 * never has to reimplement it and the two can never disagree.
 *
 * A context is validated whole and refused whole. A half-understood context
 * would change questions in ways the digest on the record no longer
 * describes, and a run that cannot say what it was asked is worth less than
 * one that stops and says why.
 */
import { readFile } from "node:fs/promises";
import type { ContextGate, ContextSkip, ContextTest, JevContext, TestCase } from "./types.ts";

export const CONTEXT_VERSION = 1;

function fail(what: string): never {
  throw new Error(`invalid context: ${what}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown, at: string): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) fail(`${at} must be an array of strings`);
  return [...v];
}

function optionalString(v: unknown, at: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") fail(`${at} must be a string`);
  return v;
}

function readGate(v: unknown): ContextGate | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) fail("gate must be an object");
  const out: ContextGate = {};
  for (const key of ["cutoff", "unsure_below", "unsure_margin"] as const) {
    const n = v[key];
    if (n === undefined || n === null) continue;
    if (typeof n !== "number" || !Number.isFinite(n)) fail(`gate.${key} must be a number`);
    out[key] = n;
  }
  if (v.basis !== undefined) out.basis = v.basis;
  return out;
}

/** The part of an entry that names a test. */
function readName(v: unknown, at: string): { file: string; title_path: string[]; project?: string } {
  if (!isRecord(v)) fail(`${at} must be an object`);
  if (typeof v.file !== "string" || v.file === "") fail(`${at}.file must be a non-empty string`);
  const title_path = strings(v.title_path, `${at}.title_path`);
  const project = optionalString(v.project, `${at}.project`);
  return { file: v.file, title_path, ...(project === undefined ? {} : { project }) };
}

function list<T>(v: unknown, at: string, read: (item: unknown, at: string) => T): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`${at} must be an array`);
  return v.map((item, i) => read(item, `${at}[${i}]`));
}

/** Validate a parsed `jev-context`. Throws on anything but a v1 context. */
export function parseContext(raw: unknown): JevContext {
  if (!isRecord(raw)) fail("expected a JSON object");
  if (raw.version !== CONTEXT_VERSION) {
    throw new Error(`unsupported context version ${String(raw.version)}; expected ${CONTEXT_VERSION}`);
  }
  if (typeof raw.digest !== "string" || raw.digest === "") fail("digest must be a non-empty string");
  const generated_at = optionalString(raw.generated_at, "generated_at");

  const skip = list(raw.skip, "skip", (item, at): ContextSkip => {
    const reason = optionalString((item as Record<string, unknown>)?.reason, `${at}.reason`);
    return { ...readName(item, at), ...(reason === undefined ? {} : { reason }) };
  });
  const tests = list(raw.tests, "tests", (item, at): ContextTest => {
    const name = readName(item, at);
    const o = item as Record<string, unknown>;
    const failed_with = strings(o.failed_with ?? [], `${at}.failed_with`);
    if (o.missed !== undefined && (typeof o.missed !== "number" || !Number.isFinite(o.missed))) {
      fail(`${at}.missed must be a number`);
    }
    return { ...name, failed_with, ...(o.missed === undefined ? {} : { missed: o.missed as number }) };
  });

  return {
    version: 1,
    digest: raw.digest,
    ...(generated_at === undefined ? {} : { generated_at }),
    gate: readGate(raw.gate),
    skip,
    tests,
  };
}

export async function loadContext(path: string): Promise<JevContext> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err: unknown) {
    throw new Error(`could not read context ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseContext(raw);
  } catch (err: unknown) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The key a context entry and a test meet on. The unit separator for the
 * reason `testId` uses it: no title a source file contains holds one.
 */
function key(file: string, titlePath: readonly string[], project: string | undefined): string {
  const base = `${file.replace(/^\.\//, "")}\u001f${titlePath.join("\u001f")}`;
  return project === undefined ? base : `${base}\u001e${project}`;
}

export interface ContextLookup {
  skipped(t: TestCase): boolean;
  /** The files this test failed with before; empty when the context says nothing. */
  failedWith(t: TestCase): readonly string[];
}

/**
 * The context indexed for per-test questions.
 *
 * An entry that names a project is about the test in that project only; one
 * that names none is about the test in every project, which is how a
 * quarantine of a test that fails in every browser is written once.
 */
export function lookup(ctx: JevContext): ContextLookup {
  const skip = new Set(ctx.skip.map((s) => key(s.file, s.title_path, s.project)));
  const hints = new Map<string, readonly string[]>();
  for (const t of ctx.tests) {
    if (t.failed_with.length > 0) hints.set(key(t.file, t.title_path, t.project), t.failed_with);
  }
  const keys = (t: TestCase) =>
    t.project === undefined ? [key(t.file, t.titlePath, undefined)] : [key(t.file, t.titlePath, t.project), key(t.file, t.titlePath, undefined)];
  return {
    skipped: (t) => keys(t).some((k) => skip.has(k)),
    failedWith: (t) => {
      for (const k of keys(t)) {
        const hit = hints.get(k);
        if (hit) return hit;
      }
      return [];
    },
  };
}
