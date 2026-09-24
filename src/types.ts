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
export type Framework = "vitest" | "jest" | "node" | "bun" | "playwright" | "rust" | "go" | "unknown";

/** One test, as the source declares it. */
export interface TestCase {
  /**
   * Repository-relative, POSIX separators. Empty when the location is not
   * known -- a Rust test cargo listed and no `#[test]` function could be
   * matched to, such as one a macro generated.
   */
  file: string;
  /** The enclosing suites outermost first, then the test's own title. */
  titlePath: string[];
  /**
   * 1-based and inclusive: the range of the test call itself. Zero when the
   * location is not known, which no changed range can overlap, so such a test
   * is scored rather than selected for free.
   */
  line: number;
  endLine: number;
  framework: Framework;
  /** Playwright project and path relative to its configured rootDir, when listed by the runner. */
  project?: string;
  runnerFile?: string;
  /**
   * The title could not be read statically -- a template with an
   * interpolation, or a `.each` row. Such a test can never be named in a
   * `-t` pattern, so it is always selected and may force file-level filtering.
   * Playwright runner discovery resolves generated titles before scoring.
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
  | "below"
  /**
   * The context from flaker put the test in `skip`. Not asked about and not
   * selected, whatever the diff did to it: a quarantined test fails for
   * reasons of its own, and running it would only say so again.
   */
  | "quarantined";

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
  const base = `${t.file}\u001f${t.titlePath.join("\u001f")}\u001f${t.line}`;
  return t.project === undefined ? base : `${base}\u001f${t.project}`;
}

/**
 * The gate values a run was decided under, spelled the way `jev-context`
 * spells them so a reader that joins the two never has to translate.
 */
export interface RecordGate {
  cutoff: number;
  unsure_below: number;
  unsure_margin: number;
}

/** A record as 0.1 wrote it. Still read; never written. */
export interface RunRecordV1 {
  version: 1;
  createdAt: string;
  base: string | null;
  framework: Framework;
  tests: TestCase[];
  /** `testId` of every test the diff touched. */
  touched: string[];
  /** Keyed by question id, which is the test's index in `tests`. */
  answers: Record<string, Answer | null>;
  fallback: string | null;
}

/**
 * A record as this version writes it: everything a run learned, and enough
 * about where it stood to join it against something else later.
 *
 * The new fields are what make a record comparable. `head_sha` and
 * `base_sha` say which change was judged, which is how a CI run of the same
 * commit finds it; `context_digest` says which hints the questions carried,
 * because a hint changes the question and two runs under different hints are
 * not the same measurement; `gate` says which values turned the answers into
 * a selection, because "this test was not selected" means nothing without
 * the cutoff it was under.
 *
 * snake_case for the new fields only: they are the ones another program is
 * meant to read, and they match the context that fed them. The old fields
 * keep their spelling so a v1 reader's code keeps working.
 */
export interface RunRecordV2 extends Omit<RunRecordV1, "version"> {
  version: 2;
  /** `git rev-parse HEAD` at the time of the run; null when there was none. */
  head_sha: string | null;
  /** The sha `--base` resolved to; null without `--base`. */
  base_sha: string | null;
  /** The `digest` of the `--context` the questions were built with; null without one. */
  context_digest: string | null;
  gate: RecordGate;
  /**
   * `testId` of every test the context quarantined. Kept, rather than
   * dropping those tests from `tests`, because a test missing from the run
   * would be run by a filter that selects "everything"; kept by `testId`
   * like `touched`, because the record is a snapshot of one commit.
   */
  quarantined: string[];
}

/**
 * Any record `loadRecord` accepts, in one shape: a v1 record reads with every
 * field it did not have as null (and nothing quarantined), so the code that
 * replays one never has to branch on the version.
 */
export type RunRecord =
  | RunRecordV2
  | (Omit<RunRecordV2, "version" | "gate"> & { version: 1; gate: null });

/**
 * What flaker knows about the tests, as its `jev-context` projection emits
 * it (`flaker export --projection jev-context`). Version 1.
 *
 * A test is named by `file` + `title_path` (+ `project` for Playwright) and
 * never by `testId`: the line in a `testId` moves with every edit above the
 * test, and flaker's history is about the test, not about where it sat.
 */
export interface JevContext {
  version: 1;
  /**
   * sha256 of `skip` and `tests`, computed by flaker. Kept verbatim on the
   * record: a hint changes a question, so runs are only comparable when their
   * digests are equal.
   */
  digest: string;
  generated_at?: string;
  /** Defaults for the gate. A flag on the command line wins over each. */
  gate: ContextGate | null;
  skip: ContextSkip[];
  tests: ContextTest[];
}

export interface ContextGate {
  cutoff?: number;
  unsure_below?: number;
  unsure_margin?: number;
  /** What the values were calibrated from. Carried, never read. */
  basis?: unknown;
}

export interface ContextSkip {
  file: string;
  title_path: string[];
  /** Absent: the test in every project. */
  project?: string;
  reason?: string;
}

export interface ContextTest {
  file: string;
  title_path: string[];
  project?: string;
  /** Changed files this test failed with before, most telling first. */
  failed_with: string[];
  /** How often a selector left it out when it then failed. Carried, never asked. */
  missed?: number;
}
