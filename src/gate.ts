/**
 * Answers in, a selection out.
 *
 * Everything here is pure and runs offline, and that separation is the point:
 * verdicts are what cost money and thresholds are what you will change twenty
 * times, so re-gating a recorded run has to be free. That is what `--replay`
 * is.
 *
 * Two rules, each of them the same one under different names:
 *
 * 1. **Confidence routes, it does not gate.** A verdict under the cutoff that
 *    the model was unsure about is selected, because running a test that did
 *    not need to run costs seconds and skipping one that did costs a release.
 * 2. **No answer is not a passing grade.** A missing or malformed answer
 *    selects the test, so a run whose requests failed cannot read as a small
 *    selection.
 */
import { questionId } from "./questions.ts";
import { testId } from "./types.ts";
import type { Answer, Selection, TestCase, Verdict } from "./types.ts";

/**
 * The boundary between "this change cannot alter the outcome" (level 1) and
 * "it might" (level 2). It is a level boundary, not a tuned number, and it is
 * the one default worth defending.
 */
export const DEFAULT_CUTOFF = 2.0;

/** Under this, the model's own ranking is not worth acting on. */
export const DEFAULT_UNSURE_BELOW = 0.5;

/** How far under the cutoff an unsure answer is still rescued. */
export const DEFAULT_UNSURE_MARGIN = 1.0;

export interface GateOptions {
  cutoff?: number;
  unsureBelow?: number;
  unsureMargin?: number;
}

/** Decide one test. Never returns null: every test gets a side and a reason. */
export function decide(
  id: string,
  t: TestCase,
  answer: Answer | null,
  touched: boolean,
  { cutoff = DEFAULT_CUTOFF, unsureBelow = DEFAULT_UNSURE_BELOW, unsureMargin = DEFAULT_UNSURE_MARGIN }: GateOptions = {},
): Verdict {
  if (touched) return { id, test: t, answer, reason: "touched", selected: true };
  if (t.dynamic) return { id, test: t, answer, reason: "dynamic", selected: true };
  if (!answer) return { id, test: t, answer: null, reason: "missing", selected: true };
  if (answer.value >= cutoff) return { id, test: t, answer, reason: "scored", selected: true };
  if (answer.confidence !== null && answer.confidence < unsureBelow && answer.value >= cutoff - unsureMargin) {
    return { id, test: t, answer, reason: "unsure", selected: true };
  }
  return { id, test: t, answer, reason: "below", selected: false };
}

/**
 * Decide every test.
 *
 * `answers` is keyed by question id, which is the test's index in `tests`;
 * `touched` is keyed by `testId`, because it is computed from the diff before
 * any question exists.
 */
export function gate(
  tests: TestCase[],
  answers: Map<string, Answer | null>,
  touched: Set<string>,
  opts: GateOptions = {},
): Selection {
  const verdicts = tests.map((t, i) => {
    const id = questionId(i);
    return decide(id, t, answers.get(id) ?? null, touched.has(testId(t)), opts);
  });
  return {
    verdicts,
    selected: verdicts.filter((v) => v.selected).map((v) => v.test),
    all: tests,
    fallback: null,
  };
}
