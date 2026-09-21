#!/usr/bin/env node
/**
 * The command line.
 *
 * Three shapes, because "easy to wire in" means different things in a
 * Makefile, in a shell and in another program:
 *
 *   jev-test-filter --base main --exec -- vitest run
 *   jev-test-filter --base main --json          -> the whole scoring
 *   jev-test-filter --base main                 -> arguments on stdout
 *
 * `--exec` is the one to reach for, and not merely out of convenience: it
 * hands the arguments to `spawn` with no shell in between, so nothing can be
 * re-split. The stdout form cannot offer that. A test name contains spaces
 * almost by definition, `renderLine` therefore quotes it, and an unquoted
 * `$(...)` word-splits without re-parsing those quotes -- so
 * `vitest run $(jev-test-filter)` hands vitest five arguments where one was
 * meant. The stdout form is for reading and for `eval`, and the help text
 * says so.
 *
 * Only this file writes to a stream or exits.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { displayName } from "./questions.ts";
import { fullName } from "./filter.ts";
import { loadRecord, replay, run, saveRecord } from "./run.ts";
import type { RunRecord, RunResult } from "./run.ts";
import type { Framework } from "./types.ts";

const FORMATS: readonly string[] = ["vitest", "jest", "node", "playwright", "rust", "go", "auto"];

export interface CliArgs {
  base: string | null;
  staged: boolean;
  paths: string[];
  format: Framework | null;
  cutoff: number | undefined;
  concurrency: number | undefined;
  json: boolean;
  dryRun: boolean;
  replayPath: string | null;
  exec: string[] | null;
  help: boolean;
}

/**
 * `--exec` takes everything after the `--` that follows it, so the runner's
 * own flags never have to be escaped past this parser.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const execAt = argv.indexOf("--exec");
  const own = execAt === -1 ? argv : argv.slice(0, execAt);
  let exec: string[] | null = null;
  if (execAt !== -1) {
    const rest = argv.slice(execAt + 1);
    exec = rest[0] === "--" ? rest.slice(1) : rest;
    if (exec.length === 0) throw new Error("--exec needs a command, e.g. --exec -- vitest run");
  }

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      staged: { type: "boolean", default: false },
      format: { type: "string", default: "auto" },
      cutoff: { type: "string" },
      concurrency: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      replay: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const format = String(values.format);
  if (!FORMATS.includes(format)) {
    throw new Error(`unknown --format ${format}; expected one of ${FORMATS.join(", ")}`);
  }

  return {
    base: values.base === undefined ? null : String(values.base),
    staged: Boolean(values.staged),
    paths: positionals,
    format: format === "auto" ? null : (format as Framework),
    cutoff: values.cutoff === undefined ? undefined : Number(values.cutoff),
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
    json: Boolean(values.json),
    dryRun: Boolean(values["dry-run"]),
    replayPath: values.replay === undefined ? null : String(values.replay),
    exec,
    help: Boolean(values.help),
  };
}

/**
 * Shell-safe single quoting, for a line a human will read or `eval`.
 *
 * Not for an unquoted `$(...)`: that word-splits without re-parsing quotes,
 * so a quoted test name arrives as several arguments. `--exec` exists so
 * that nobody has to get this right.
 */
function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function renderLine(res: RunResult): string {
  return res.filter.argv.map(quote).join(" ");
}

/** The command to run, or null when nothing was selected. */
export function execArgv(cmd: string[], res: RunResult): string[] | null {
  if (res.filter.mode === "none") return null;
  return [...cmd, ...res.filter.argv];
}

/**
 * The status the stdout form exits with when nothing was selected.
 *
 * An empty argv is what "everything was selected" and "nothing was selected"
 * both look like on stdout, and the second must not read as the first: a
 * shell that runs `eval "vitest run $(jev-test-filter)"` on an empty line
 * runs the WHOLE suite, which is the opposite of what the tool decided.
 * `--exec` has no such ambiguity, which is why it is the shape to reach for.
 */
export const EXIT_NOTHING_SELECTED = 3;

/** The status of the stdout form, which is the only shape that needs one. */
export function stdoutExitCode(res: RunResult): number {
  return res.filter.mode === "none" ? EXIT_NOTHING_SELECTED : 0;
}

/**
 * Whether this run's record is worth keeping.
 *
 * A fallback record holds no answers -- the run never got any, or gave up on
 * the ones it had. Writing it over the last good record destroys exactly the
 * material `--replay` exists to re-gate, and it was measured happening: one
 * `HTTP 529 system_overloaded` replaced a complete scoring, and the next
 * `--replay` reported the 529 instead of re-gating the earlier answers.
 */
export function shouldSaveRecord(record: RunRecord): boolean {
  return record.fallback === null;
}

export function renderJson(res: RunResult): string {
  return `${JSON.stringify(
    {
      framework: res.framework,
      mode: res.filter.mode,
      argv: res.filter.argv,
      fallback: res.selection.fallback,
      selected: res.selection.selected.length,
      total: res.selection.all.length,
      spent: res.spent,
      tests: res.selection.verdicts.map((v) => ({
        file: v.test.file,
        name: displayName(v.test),
        pattern_name: fullName(v.test),
        line: v.test.line,
        selected: v.selected,
        reason: v.reason,
        score: v.answer?.value ?? null,
        confidence: v.answer?.confidence ?? null,
      })),
    },
    null,
    2,
  )}\n`;
}

const HELP = `jev-test-filter — score every test against a git diff and emit runner arguments

Usage:
  jev-test-filter [options] --exec -- <command...>
  jev-test-filter [options] [paths...]

Options:
  --base <ref>        compare against the merge base with <ref>, as a pull request does
  --staged            use the staged change instead of the working tree
  --format <name>     vitest | jest | node | playwright | rust | go | auto  (default: auto)
  --cutoff <n>        select at or above this score level (default: 2)
  --concurrency <n>   requests in flight at once
  --json              print the full scoring instead of the arguments
  --dry-run           extract and report without calling Jev
  --replay <file>     re-gate a recorded run offline (default: .jev-test-filter/last.json)
  --exec -- <cmd...>  append the arguments to <cmd...> and run it
  -h, --help          this text

Examples:
  jev-test-filter --base main --exec -- vitest run
  jev-test-filter --base main --format node --exec -- node --test
  jev-test-filter --base main --format go --exec -- go test
  jev-test-filter --base main --format rust --exec -- cargo test
  jev-test-filter --base main --json > selection.json

Rust is never discovered automatically: listing its tests builds the test
targets, so it happens only under --format rust.

Without --exec the arguments are written to stdout, shell-quoted. They are
meant to be read, or passed through eval:

  eval "vitest run $(jev-test-filter --base main)"

An unquoted $(...) will not work: a test name contains spaces, so the
arguments are quoted, and the shell word-splits them without re-parsing the
quotes. Use --exec instead of working around it.

Environment:
  TYPESAFE_API_KEY    required unless --dry-run or --replay
`;

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err: unknown) {
    process.stderr.write(`jev-test-filter: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let res: RunResult;
  if (args.replayPath !== null) {
    const record = await loadRecord(args.replayPath || ".jev-test-filter/last.json");
    const selection = replay(record, args.cutoff === undefined ? {} : { cutoff: args.cutoff });
    const { buildFilter } = await import("./filter.ts");
    res = {
      selection,
      framework: record.framework,
      filter: selection.fallback === null ? buildFilter(selection, record.framework) : { mode: "all", argv: [] },
      record,
      spent: null,
    };
  } else {
    res = await run({
      base: args.base,
      staged: args.staged,
      paths: args.paths,
      format: args.format,
      dryRun: args.dryRun,
      ...(args.cutoff === undefined ? {} : { cutoff: args.cutoff }),
      ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
    });
    if (shouldSaveRecord(res.record)) await saveRecord(process.cwd(), res.record);
  }

  if (res.selection.fallback !== null) {
    process.stderr.write(`jev-test-filter: running everything (${res.selection.fallback})\n`);
  } else {
    const { selected, all } = res.selection;
    process.stderr.write(`jev-test-filter: ${selected.length}/${all.length} tests selected (${res.filter.mode})\n`);
  }

  if (args.json) {
    process.stdout.write(renderJson(res));
    return 0;
  }

  if (args.exec) {
    const argv = execArgv(args.exec, res);
    if (argv === null) {
      process.stderr.write("jev-test-filter: nothing selected; not running\n");
      return 0;
    }
    return await new Promise<number>((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", (err) => {
        process.stderr.write(`jev-test-filter: ${err.message}\n`);
        resolve(127);
      });
    });
  }

  process.stdout.write(`${renderLine(res)}\n`);
  return stdoutExitCode(res);
}

// Only run when invoked as a program, so the tests can import the renderers.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`jev-test-filter: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
