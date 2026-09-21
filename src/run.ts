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
import { loadDiff, touchesChange } from "./diff.ts";
import type { ChangedRanges } from "./diff.ts";
import { detectFramework, findTestFiles } from "./framework.ts";
import { extractTests } from "./extract.ts";
import { buildState } from "./state.ts";
import type { StatePayload } from "./state.ts";
import { buildQuestion, questionId, readAnswer } from "./questions.ts";
import type { ScoreQuestion } from "./questions.ts";
import { gate } from "./gate.ts";
import type { GateOptions } from "./gate.ts";
import { buildFilter } from "./filter.ts";
import type { FilterArgs } from "./filter.ts";
import { Jev, mapLimit, DEFAULT_CONCURRENCY } from "./jev.ts";
import type { AskClient, Spend } from "./jev.ts";
import { testId } from "./types.ts";
import type { Answer, Framework, Selection, TestCase } from "./types.ts";

/** Where a run's answers are kept, for `--replay`. */
export const RECORD_DIR = ".jev-test-filter";
export const RECORD_FILE = "last.json";

export interface RunRecord {
  version: 1;
  createdAt: string;
  base: string | null;
  framework: Framework;
  tests: TestCase[];
  /** `testId` of every test the diff touched. */
  touched: string[];
  answers: Record<string, Answer | null>;
  fallback: string | null;
}

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
  { client = null, concurrency = DEFAULT_CONCURRENCY, batchSize = 400 }: ScoreOptions = {},
): Promise<Map<string, Answer | null>> {
  const jev = client ?? new Jev();
  const out = new Map<string, Answer | null>();
  tests.forEach((_, i) => out.set(questionId(i), null));

  const batches: Array<Record<string, ScoreQuestion>> = [];
  for (let i = 0; i < tests.length; i += batchSize) {
    const batch: Record<string, ScoreQuestion> = {};
    for (let j = i; j < Math.min(i + batchSize, tests.length); j += 1) {
      const id = questionId(j);
      batch[id] = buildQuestion(tests[j]!, id);
    }
    batches.push(batch);
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
}

export interface RunResult {
  selection: Selection;
  framework: Framework;
  filter: FilterArgs;
  record: RunRecord;
  spent: Spend | null;
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

  const files = await findTestFiles(cwd, opts.paths ?? []);
  const all: TestCase[] = [];
  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8");
    const framework = detectFramework(source);
    if (opts.format && framework !== opts.format) continue;
    all.push(...extractTests(source, file, framework));
  }

  if (all.length === 0) {
    const record: RunRecord = {
      version: 1,
      createdAt: new Date().toISOString(),
      base: opts.base ?? null,
      framework: opts.format ?? "unknown",
      tests: [],
      touched: [],
      answers: {},
      fallback: "no tests were extracted",
    };
    const selection = everything([], "no tests were extracted");
    return { selection, framework: record.framework, filter: { mode: "all", argv: [] }, record, spent: null };
  }

  const framework = opts.format ?? pickFramework(all);
  const touched = collect(all, diff.ranges);
  const state = buildState(diff.text, diff.stat);

  let answers = new Map<string, Answer | null>();
  let spent: Spend | null = null;
  let selection: Selection;
  if (opts.dryRun) {
    selection = everything(all, "--dry-run: no questions were asked");
  } else {
    try {
      const client = opts.client ?? new Jev();
      answers = await score(all, state, {
        client,
        ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
        ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
      });
      spent = client.spent;
      selection = gate(all, answers, touched, opts);
    } catch (err: unknown) {
      selection = everything(all, `jev failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A truncated diff that still deselects most of the suite is a selection
  // made from a state that was missing the change it should have judged.
  if (selection.fallback === null && state.truncated && selection.selected.length / all.length < 0.5) {
    selection = everything(all, "the diff did not fit the state budget and the selection was small");
  }

  const record: RunRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    base: opts.base ?? null,
    framework,
    tests: all,
    touched: [...touched],
    answers: Object.fromEntries(answers),
    fallback: selection.fallback,
  };

  const filter =
    selection.fallback === null
      ? buildFilter(selection, framework, opts.fileThreshold === undefined ? {} : { fileThreshold: opts.fileThreshold })
      : { mode: "all" as const, argv: [] };

  return { selection, framework, filter, record, spent };
}

/** Re-gate a recorded run at today's cutoffs, offline. */
export function replay(record: RunRecord, opts: GateOptions = {}): Selection {
  if (record.fallback !== null) return everything(record.tests, record.fallback);
  const answers = new Map(Object.entries(record.answers));
  return gate(record.tests, answers, new Set(record.touched), opts);
}

export async function saveRecord(cwd: string, record: RunRecord): Promise<string> {
  const dir = join(cwd, RECORD_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, RECORD_FILE);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

export async function loadRecord(path: string): Promise<RunRecord> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as RunRecord;
  if (parsed.version !== 1) throw new Error(`unsupported record version ${String(parsed.version)}`);
  return parsed;
}
