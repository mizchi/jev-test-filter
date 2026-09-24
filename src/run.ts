/**
 * The run: a diff and a repository in, a selection and the runner's arguments
 * out.
 *
 * The only part of the program that touches the network and the filesystem at
 * once. Everything it decides with is a pure function it calls, and
 * everything it learns is written to a record, so `replay` can reach the same
 * selection again for free under a different cutoff.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDiff, resolveSha, touchesChange } from "./diff.ts";
import type { ChangedRanges } from "./diff.ts";
import { discoverTests } from "./discover.ts";
import { buildState } from "./state.ts";
import type { StatePayload } from "./state.ts";
import { buildQuestion, questionId, readAnswer } from "./questions.ts";
import type { ScoreQuestion } from "./questions.ts";
import { gate, gateOptions, resolveGate } from "./gate.ts";
import type { GateOptions } from "./gate.ts";
import { buildFilter } from "./filter.ts";
import { listPlaywrightTests } from "./playwright.ts";
import type { FilterArgs } from "./filter.ts";
import { Jev, mapLimit, DEFAULT_CONCURRENCY } from "./jev.ts";
import type { AskClient, Spend } from "./jev.ts";
import { lookup } from "./context.ts";
import type { ContextLookup } from "./context.ts";
import { testId } from "./types.ts";
import type { Answer, Framework, JevContext, RunRecord, RunRecordV1, RunRecordV2, Selection, TestCase } from "./types.ts";

export type { RecordGate, RunRecord, RunRecordV1, RunRecordV2 } from "./types.ts";

/** Where a run's answers are kept, for `--replay`. */
export const RECORD_DIR = ".jev-test-filter";
export const RECORD_FILE = "last.json";
/**
 * One record per commit, under `RECORD_DIR`, named `<head_sha>.json`.
 *
 * `last.json` alone is overwritten by the next run, and the run a CI result
 * has to be compared with is rarely the last one on this machine. Keyed by
 * the head rather than by time because the head is what the other side of
 * that comparison knows.
 */
export const RECORDS_SUBDIR = "records";

/**
 * The framework the run is for.
 *
 * A repository with Vitest unit tests and Playwright specs is normal, and
 * there is no single command that runs both, so a mixed set is a question for
 * the user rather than a guess for this function.
 */
export function pickFramework(tests: TestCase[]): Framework {
  const kinds = [...new Set(tests.map((t) => t.framework))];
  if (kinds.length === 1) return kinds[0]!;
  throw new Error(
    `the selected tests span more than one framework (${kinds.join(", ")}); ` +
      `narrow the run with a path argument or pick one with --format`,
  );
}

/** The tests whose own bodies the diff touched. Keyed by `testId`. */
export function collect(tests: TestCase[], ranges: ChangedRanges): Set<string> {
  const out = new Set<string>();
  for (const t of tests) {
    if (touchesChange(ranges, t.file, t.line, t.endLine)) out.add(testId(t));
  }
  return out;
}

export interface ScoreOptions {
  client?: AskClient | null;
  concurrency?: number;
  /**
   * Questions per request. The server has no documented cap on the number of
   * questions and over a thousand in one request is fine, but a batch bounds
   * how much one `max_tokens_exceeded` split has to redo.
   */
  batchSize?: number;
  /**
   * What `--context` knows. A test it skips is not asked about -- its answer
   * stays null and the gate reports it quarantined -- and a test it has
   * history for is asked with that history.
   */
  context?: ContextLookup | null;
}

/**
 * Ask about every test.
 *
 * Answers come back keyed by question id, and a question with no answer stays
 * null: the gate selects a test with no answer, and a zero here would silently
 * deselect it instead.
 */
export async function score(
  tests: TestCase[],
  state: StatePayload,
  { client = null, concurrency = DEFAULT_CONCURRENCY, batchSize = 400, context = null }: ScoreOptions = {},
): Promise<Map<string, Answer | null>> {
  const jev = client ?? new Jev();
  const out = new Map<string, Answer | null>();
  tests.forEach((_, i) => out.set(questionId(i), null));

  // Question ids stay the test's index in `tests` even with skipped tests
  // left out, so a record's answers line up with its tests either way.
  const asked: Array<[string, ScoreQuestion]> = [];
  tests.forEach((t, i) => {
    if (context?.skipped(t)) return;
    const id = questionId(i);
    asked.push([id, buildQuestion(t, id, context?.failedWith(t) ?? [])]);
  });
  const batches: Array<Record<string, ScoreQuestion>> = [];
  for (let i = 0; i < asked.length; i += batchSize) {
    batches.push(Object.fromEntries(asked.slice(i, i + batchSize)));
  }

  const responses = await mapLimit(batches, concurrency, (batch) => jev.askSplitting(state, batch));
  for (const res of responses) {
    for (const [id, raw] of Object.entries(res.answers ?? {})) {
      if (out.has(id)) out.set(id, readAnswer(raw));
    }
  }
  return out;
}

export interface RunOptions extends GateOptions {
  cwd?: string;
  base?: string | null;
  staged?: boolean;
  paths?: string[];
  /** Restrict the run to one framework instead of requiring a single one. */
  format?: Framework | null;
  client?: AskClient | null;
  concurrency?: number;
  batchSize?: number;
  fileThreshold?: number;
  /** Extract and gate but never call Jev; every test scores as missing. */
  dryRun?: boolean;
  /** When using Playwright, collect its actual test list with this runner command. */
  playwrightCommand?: string[];
  /**
   * flaker's `jev-context`, already validated. Its gate values are defaults:
   * a value set in these options wins over each.
   */
  context?: JevContext | null;
}

/**
 * The gate a run decides under: the options' own values over the context's,
 * over the defaults. Only values actually present count, so an option passed
 * as `undefined` does not erase the context's value.
 */
export function effectiveGate(opts: GateOptions, context: JevContext | null = null): GateOptions {
  const out: GateOptions = {};
  const g = context?.gate;
  if (g?.cutoff !== undefined) out.cutoff = g.cutoff;
  if (g?.unsure_below !== undefined) out.unsureBelow = g.unsure_below;
  if (g?.unsure_margin !== undefined) out.unsureMargin = g.unsure_margin;
  if (opts.cutoff !== undefined) out.cutoff = opts.cutoff;
  if (opts.unsureBelow !== undefined) out.unsureBelow = opts.unsureBelow;
  if (opts.unsureMargin !== undefined) out.unsureMargin = opts.unsureMargin;
  return out;
}

export interface RunResult {
  selection: Selection;
  framework: Framework;
  filter: FilterArgs;
  record: RunRecord;
  spent: Spend | null;
}

/** What labels a record: which change was judged, and under which gate. */
async function stamp(cwd: string, opts: RunOptions): Promise<Pick<RunRecordV2, "head_sha" | "base_sha" | "context_digest" | "gate">> {
  const base = opts.base ?? null;
  return {
    head_sha: await resolveSha("HEAD", cwd),
    base_sha: base === null ? null : await resolveSha(base, cwd),
    context_digest: opts.context?.digest ?? null,
    gate: resolveGate(effectiveGate(opts, opts.context ?? null)),
  };
}

/**
 * A selection is an optimization and never a correctness gate, so every
 * failure below takes the same exit: run everything, and say why on the
 * result rather than in a log nobody reads.
 */
function everything(tests: TestCase[], reason: string): Selection {
  return {
    verdicts: tests.map((t, i) => ({ id: questionId(i), test: t, answer: null, reason: "missing", selected: true })),
    selected: tests,
    all: tests,
    fallback: reason,
  };
}

export async function run(opts: RunOptions = {}): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const diff = await loadDiff({ cwd, base: opts.base ?? null, staged: opts.staged ?? false });

  let all: TestCase[] = [];
  let discoveryFailure: string | null = null;
  try {
    all = opts.format === "playwright" && opts.playwrightCommand
      ? (await listPlaywrightTests(cwd, opts.playwrightCommand)).filter((t) =>
          !opts.paths?.length || opts.paths.some((path) => {
            const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
            return t.file === normalized || t.file.startsWith(`${normalized}/`);
          }))
      : await discoverTests(cwd, opts.paths ?? [], opts.format ?? null);
  } catch (err: unknown) {
    if (opts.format !== "playwright" || !opts.playwrightCommand) throw err;
    discoveryFailure = `Playwright test listing failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (all.length === 0) {
    const record: RunRecordV2 = {
      version: 2,
      createdAt: new Date().toISOString(),
      base: opts.base ?? null,
      ...(await stamp(cwd, opts)),
      framework: opts.format ?? "unknown",
      tests: [],
      touched: [],
      quarantined: [],
      answers: {},
      fallback: discoveryFailure ?? "no tests were extracted",
    };
    const selection = everything([], record.fallback!);
    return { selection, framework: record.framework, filter: { mode: "all", argv: [] }, record, spent: null };
  }

  const framework = opts.format ?? pickFramework(all);
  const touched = collect(all, diff.ranges);
  const context = opts.context ? lookup(opts.context) : null;
  const quarantined = new Set(context ? all.filter((t) => context.skipped(t)).map(testId) : []);
  const gateOpts = effectiveGate(opts, opts.context ?? null);
  const state = buildState(diff.text, diff.stat);

  let answers = new Map<string, Answer | null>();
  let spent: Spend | null = null;
  let selection: Selection;
  if (opts.dryRun) {
    selection = everything(all, "--dry-run: no questions were asked");
  } else {
    let failure: string | null = null;
    try {
      const client = opts.client ?? new Jev();
      answers = await score(all, state, {
        client,
        ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
        ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
        context,
      });
      spent = client.spent;
    } catch (err: unknown) {
      failure = `jev failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Gating is pure and offline, so it stays outside the try: a bug in the
    // gate must not be reported to the user as a network failure.
    selection = failure === null ? gate(all, answers, touched, gateOpts, quarantined) : everything(all, failure);
  }

  // A truncated diff that still deselects most of the suite is a selection
  // made from a state that was missing the change it should have judged.
  // Quarantined tests were never candidates, so they count on neither side.
  const candidates = all.length - quarantined.size;
  if (selection.fallback === null && state.truncated && candidates > 0 && selection.selected.length / candidates < 0.5) {
    selection = everything(all, "the diff did not fit the state budget and the selection was small");
  }

  const record: RunRecordV2 = {
    version: 2,
    createdAt: new Date().toISOString(),
    base: opts.base ?? null,
    ...(await stamp(cwd, opts)),
    framework,
    tests: all,
    touched: [...touched],
    quarantined: [...quarantined],
    answers: Object.fromEntries(answers),
    fallback: selection.fallback,
  };

  const filter =
    selection.fallback === null
      ? buildFilter(selection, framework, opts.fileThreshold === undefined ? {} : { fileThreshold: opts.fileThreshold })
      : { mode: "all" as const, argv: [] };

  return { selection, framework, filter, record, spent };
}

/**
 * Re-gate a recorded run, offline.
 *
 * Under the record's own gate by default, so a bare replay reproduces the
 * selection the run made; a value in `opts` replaces the recorded one, which
 * is what trying another cutoff is. A v1 record kept no gate, and replays
 * under the defaults as it always did.
 */
export function replay(record: RunRecord, opts: GateOptions = {}): Selection {
  if (record.fallback !== null) return everything(record.tests, record.fallback);
  const answers = new Map(Object.entries(record.answers));
  return gate(record.tests, answers, new Set(record.touched), { ...gateOptions(record.gate), ...effectiveGate(opts) }, new Set(record.quarantined));
}

/**
 * Write the record to `last.json`, and to `records/<head_sha>.json` when the
 * head is known. Returns every path written, `last.json` first.
 *
 * Whether a record should be written at all -- a fallback should not -- is
 * the caller's decision, see `shouldSaveRecord`.
 */
export async function saveRecord(cwd: string, record: RunRecord): Promise<string[]> {
  const dir = join(cwd, RECORD_DIR);
  await mkdir(dir, { recursive: true });
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const paths = [join(dir, RECORD_FILE)];
  if (record.head_sha !== null) {
    await mkdir(join(dir, RECORDS_SUBDIR), { recursive: true });
    paths.push(join(dir, RECORDS_SUBDIR, `${record.head_sha}.json`));
  }
  for (const path of paths) await writeFile(path, text, "utf8");
  return paths;
}

/**
 * Read a record of either version. A v1 record comes back with every field
 * it did not have as null, and nothing quarantined; its `version` stays 1,
 * so a reader can still tell it kept no gate.
 */
type RunRecordV1Fields = Omit<RunRecordV1, "version">;

export async function loadRecord(path: string): Promise<RunRecord> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
  if (parsed.version === 2) {
    // Written by this version, or by hand; a missing label reads as unknown.
    const v2 = parsed as Partial<RunRecordV2> & RunRecordV1Fields;
    return {
      ...v2,
      version: 2,
      head_sha: v2.head_sha ?? null,
      base_sha: v2.base_sha ?? null,
      context_digest: v2.context_digest ?? null,
      gate: v2.gate ?? resolveGate(),
      quarantined: v2.quarantined ?? [],
    };
  }
  if (parsed.version === 1) {
    const v1 = parsed as RunRecordV1;
    return { ...v1, head_sha: null, base_sha: null, context_digest: null, gate: null, quarantined: [] };
  }
  throw new Error(`unsupported record version ${String(parsed.version)}`);
}
