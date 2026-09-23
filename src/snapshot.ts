/** Read-only review of changed text snapshots. Jev returns decisions, not prose. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "@ast-grep/napi";
import { parseUnifiedDiff, splitDiffByFile, touchesChange } from "./diff.ts";
import { langFor } from "./framework.ts";
import { Jev } from "./jev.ts";
import type { AskClient, Spend } from "./jev.ts";
import { questionId, readAnswer } from "./questions.ts";
import { buildState } from "./state.ts";

export interface SnapshotChange {
  file: string;
  kind: "external" | "inline";
}

export interface SnapshotAssessment extends SnapshotChange {
  status: "plausible" | "review" | "unknown";
  score: number | null;
  confidence: number | null;
}

export interface SnapshotReview {
  entries: SnapshotAssessment[];
  error: string | null;
  spent: Spend | null;
}

export interface SnapshotTestSources {
  sources: Record<string, string>;
  omitted: string[];
}

const execFileAsync = promisify(execFile);

async function readSource(cwd: string, file: string, revision: "HEAD" | ":" | null): Promise<string> {
  if (revision === null) return readFile(join(cwd, file), "utf8");
  const spec = revision === ":" ? `:${file}` : `HEAD:${file}`;
  const { stdout } = await execFileAsync("git", ["show", spec], { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export function snapshotTestFile(change: SnapshotChange): string | null {
  if (change.kind === "inline") return change.file;
  if (!/(^|\/)__snapshots__\//.test(change.file)) return null;
  return change.file.replace(/(^|\/)__snapshots__\//, "$1").replace(/\.snap$/, "");
}

/** Bound extra source context so the shared Jev state still fits its token budget. */
export async function loadSnapshotTestSources(
  cwd: string, changes: SnapshotChange[], maxChars = 24_000, revision: "HEAD" | ":" | null = null,
): Promise<SnapshotTestSources> {
  const sources: Record<string, string> = {};
  const omitted: string[] = [];
  let used = 0;
  for (const file of new Set(changes.map(snapshotTestFile).filter((file): file is string => file !== null))) {
    try {
      const source = await readSource(cwd, file, revision);
      if (used + source.length > maxChars) {
        omitted.push(file);
        continue;
      }
      sources[file] = source;
      used += source.length;
    } catch {
      omitted.push(file);
    }
  }
  return { sources, omitted };
}

export function findSnapshotChanges(diff: string): SnapshotChange[] {
  const out: SnapshotChange[] = [];
  for (const [file, section] of splitDiffByFile(diff)) {
    if (file.endsWith(".snap")) {
      out.push({ file, kind: "external" });
    } else if (/\.(?:test|vitest|spec)\.[cm]?[jt]sx?$/.test(file)
      && /^[+-](?![+-]).*toMatchInlineSnapshot\s*\(/m.test(section)) {
      out.push({ file, kind: "inline" });
    }
  }
  return out;
}

/** Match changed lines against complete inline assertion calls, including multiline values. */
export async function findSnapshotChangesInWorktree(
  diff: string, cwd: string, revision: "HEAD" | ":" | null = null,
): Promise<SnapshotChange[]> {
  const found = findSnapshotChanges(diff);
  const seen = new Set(found.map((change) => change.file));
  for (const [file, ranges] of parseUnifiedDiff(diff)) {
    if (seen.has(file) || !/\.(?:test|vitest|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    let source: string;
    try {
      source = await readSource(cwd, file, revision);
    } catch {
      continue;
    }
    const root = parse(langFor(file), source).root();
    const calls = root.findAll({ rule: {
      kind: "call_expression",
      has: { field: "function", regex: "\\.to(?:Match(?:Aria)?|ThrowErrorMatching)InlineSnapshot$" },
    } as never });
    if (calls.some((call) => {
      const range = call.range();
      return touchesChange(new Map([[file, ranges]]), file, range.start.line + 1, range.end.line + 1);
    })) {
      found.push({ file, kind: "inline" });
      seen.add(file);
    }
  }
  return found;
}

const TASK = "The state is a git diff including updated text snapshots and, when available, the associated test source. Judge whether the NEW expected snapshot values are consistent with the intended behavior visible in that context. Do not assume that a snapshot update is correct merely because a test runner generated it. Judge only the named snapshot file. If the context is insufficient, use level 1.";
const LEVELS = [
  "The new expected values clearly follow the intentional behavior change visible in the diff.",
  "The update is plausible, but the diff does not prove the new expected values are correct.",
  "The update appears to hide an unintended behavior change or contains suspicious new expected values.",
  "The new expected values clearly contradict the intended behavior visible in the diff.",
] as const;

export async function assessSnapshots(
  diff: string, stat: string, client: AskClient = new Jev(), changes = findSnapshotChanges(diff),
  context: SnapshotTestSources = { sources: {}, omitted: [] },
): Promise<SnapshotReview> {
  if (changes.length === 0) return { entries: [], error: null, spent: null };
  const state = buildState(diff, stat, { maxChars: 64_000 });
  if (state.truncated) {
    return {
      entries: changes.map((change) => ({ ...change, status: "unknown", score: null, confidence: null })),
      error: "the diff exceeded Jev's state budget",
      spent: null,
    };
  }
  const questions = Object.fromEntries(changes.map((change, i) => [questionId(i), {
    type: "score" as const,
    instructions: { task: TASK, subject: questionId(i), snapshot_file: change.file, snapshot_kind: change.kind },
    criteria: LEVELS,
  }]));
  try {
    const response = await client.askSplitting({ ...state, snapshot_test_sources: context.sources }, questions);
    return {
      entries: changes.map((change, i) => {
        const answer = readAnswer(response.answers?.[questionId(i)]);
        const sourceMissing = context.omitted.includes(snapshotTestFile(change) ?? "");
        return {
          ...change,
          status: answer === null || sourceMissing ? "unknown" : answer.value >= 1 || answer.confidence === null || answer.confidence < 0.6 ? "review" : "plausible",
          score: answer?.value ?? null,
          confidence: answer?.confidence ?? null,
        };
      }),
      error: null,
      spent: client.spent,
    };
  } catch (err: unknown) {
    return {
      entries: changes.map((change) => ({ ...change, status: "unknown", score: null, confidence: null })),
      error: err instanceof Error ? err.message : String(err),
      spent: client.spent,
    };
  }
}
