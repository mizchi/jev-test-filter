/**
 * The contract every other module speaks.
 *
 * Nothing here reaches the network or the filesystem, so a test of any layer
 * can build its own inputs by hand.
 */

/**
 * Which runner a test belongs to. It decides how the full name is spelled and
 * which flag carries the selection, so it is carried per test rather than per
 * run: a repository with both Vitest unit tests and Playwright specs is normal.
 *
 * `jest` is separate from `vitest` only so a report can name it; the two share
 * a filter shape exactly.
 */
export type Framework = "vitest" | "jest" | "node" | "playwright" | "unknown";

/** One test, as the source declares it. */
export interface TestCase {
  /** Repository-relative, POSIX separators. */
  file: string;
  /** The enclosing suites outermost first, then the test's own title. */
  titlePath: string[];
  /** 1-based and inclusive: the range of the test call itself. */
  line: number;
  endLine: number;
  framework: Framework;
  /**
   * The title could not be read statically -- a template with an
   * interpolation, or a `.each` row. Such a test can never be named in a
   * `-t` pattern, so it is always selected and it forces the whole run down
   * to file-level filtering.
   */
  dynamic: boolean;
}

/** A usable answer to one question. Absent rather than zero when unusable. */
export interface Answer {
  /** The score level, 0 to 3. */
  value: number;
  /** How sure the model is. Routes an uncertain verdict; never gates one. */
  confidence: number | null;
}

/**
 * Why a test ended up on the side it did. Reported, not just logged: a
 * selection nobody can explain is one nobody will trust enough to leave on.
 */
export type Reason =
  /** The test's own body is inside the diff. Selected without asking. */
  | "touched"
  /** The title is not statically knowable. Selected to be safe. */
  | "dynamic"
  /** The score reached the cutoff. */
  | "scored"
  /** Near the cutoff and the model was unsure. Selected to be safe. */
  | "unsure"
  /** No usable answer came back. Selected to be safe. */
  | "missing"
  /** The score was under the cutoff. Not selected. */
  | "below";

export interface Verdict {
  /** The question this test was asked under, e.g. `q0007`. */
  id: string;
  test: TestCase;
  answer: Answer | null;
  reason: Reason;
  selected: boolean;
}

export interface Selection {
  verdicts: Verdict[];
  selected: TestCase[];
  all: TestCase[];
  /**
   * Non-null when the run gave up on selecting and everything is to be run.
   * The string is the reason, shown to the user.
   */
  fallback: string | null;
}

/**
 * A stable key for one test.
 *
 * The line is part of it because two tests in one file may legitimately share
 * a full name, and a key that collides would let one test's answer decide the
 * other's fate. The unit separator cannot occur in a JavaScript string
 * literal a source file actually contains, so the three parts cannot be
 * confused with one another.
 */
export function testId(t: TestCase): string {
  return `${t.file}\u001f${t.titlePath.join("\u001f")}\u001f${t.line}`;
}
