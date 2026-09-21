/**
 * One question per test.
 *
 * `score` rather than `choice` because the answer is an ordered conclusion:
 * asking "how much can this change break this test" as an unordered choice
 * discards the ordering, splits the probability mass between adjacent levels,
 * and returns a low confidence that is indistinguishable from real
 * uncertainty.
 *
 * No threshold ever appears in a question. The cutoff is a decision the gate
 * makes from the answer; writing it into the question would mean every
 * recalibration rewrote the question, and no run could be compared with an
 * earlier one.
 */
import type { TestCase } from "./types.ts";

export interface ScoreQuestion {
  type: "score";
  instructions: Record<string, unknown>;
  criteria: readonly string[];
}

const TASK =
  "The state is a git diff. Judge only the one test identified below, and only " +
  "for whether this change can alter its outcome -- other problems with the test " +
  "or with the change are not your concern here.";

export const SCORE_LEVELS = [
  "Unrelated to this change: running this test cannot produce a different result than before.",
  "This test exercises code the change touched, but nothing in the change can alter its outcome.",
  "This test could be affected by the change: it might fail.",
  "This test directly exercises behaviour the change altered or broke: it is likely to fail.",
] as const;

export const SCORE_LEVEL_NAMES = ["unrelated", "unaffected", "at-risk", "likely-failing"] as const;

/** Stable question name, so answers can be matched back by the test's index. */
export function questionId(i: number): string {
  return `q${String(i).padStart(4, "0")}`;
}

/**
 * The name the test is asked about is the runner's own spelling of it, so a
 * reader of `--json` can paste it into `-t` and see the same test. Playwright
 * is selected by location rather than by name, so its chain is joined the way
 * its reporter prints it.
 */
export function displayName(t: TestCase): string {
  if (t.framework === "rust") return t.titlePath.join("::");
  if (t.framework === "go") return t.titlePath.join("/");
  const sep = t.framework === "node" ? " " : " > ";
  return t.titlePath.join(sep);
}

export function buildQuestion(t: TestCase, id: string): ScoreQuestion {
  return {
    type: "score",
    instructions: {
      task: TASK,
      subject: id,
      test_file: t.file,
      test_name: displayName(t),
      test_lines: t.line === t.endLine ? `${t.line}` : `${t.line}-${t.endLine}`,
    },
    criteria: SCORE_LEVELS,
  };
}

/**
 * One answer, or null when it cannot be used.
 *
 * Null rather than zero: a malformed answer must select the test, and a zero
 * would silently deselect it.
 */
export function readAnswer(raw: unknown): { value: number; confidence: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const v = typeof o.score === "number" ? o.score : typeof o.value === "number" ? o.value : null;
  if (v === null || !Number.isFinite(v)) return null;
  const c = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : null;
  return { value: v, confidence: c };
}
