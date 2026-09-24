/**
 * What the change touched.
 *
 * Two things come out of one `git diff`: the post-image line ranges, which
 * decide which tests are selected without asking, and the diff text itself,
 * which is the `state` every question is asked against.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Post-image line ranges per file, inclusive at both ends. */
export type ChangedRanges = Map<string, Array<[number, number]>>;

/** git's own prefixes, including the `diff.mnemonicPrefix` spellings. */
const PREFIX = /^[abciwo]\//;

/**
 * Parse the `@@ -a,b +c,d @@` headers of a unified diff.
 *
 * A file header is only read before the section's first hunk. Inside a hunk
 * every line carries an added or removed marker, so adding the C++ line
 * `++ x;` produces a body line spelled `+++ x;` -- indistinguishable from a
 * file header to anything that does not track where it is.
 */
export function parseUnifiedDiff(text: string): ChangedRanges {
  const byFile: ChangedRanges = new Map();
  let file: string | null = null;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      // A post-image of /dev/null is a deletion: nothing in the new tree
      // changed, so there is no line here a test's body can overlap. The
      // deletion still reaches the model, through `splitDiffByFile`.
      file = path === "/dev/null" ? null : path.replace(PREFIX, "");
      if (file && !byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (!line.startsWith("@@")) continue;
    inHunk = true;
    if (!file) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    byFile.get(file)!.push([start, start + count - 1]);
  }
  for (const [k, ranges] of byFile) {
    if (ranges.length === 0) byFile.delete(k);
    else byFile.set(k, merge(ranges));
  }
  return byFile;
}

function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]!];
  for (const [s, e] of sorted.slice(1)) {
    const last = out.at(-1)!;
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Does `[line, endLine]` intersect any changed range for this file? */
export function touchesChange(ranges: ChangedRanges, file: string, line: number, endLine: number): boolean {
  const list = ranges.get(file);
  if (!list) return false;
  return list.some(([s, e]) => line <= e && endLine >= s);
}

/**
 * The diff cut into one section per file, keyed by post-image path -- or, for
 * a file the change deletes, by its pre-image path.
 *
 * This is where `parseUnifiedDiff` and this function deliberately part ways.
 * Ranges answer "which test bodies did the change touch", and a deleted file
 * has no post-image line any test body can sit on. Sections answer "what
 * should the model see", and deleting a source file is one of the changes
 * most likely to break a test -- dropping it would hide the change from the
 * judgment it matters most to.
 *
 * The state builder drops whole sections to fit its budget, and a section is
 * the smallest piece that still reads as a diff.
 */
export function splitDiffByFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  let buf: string[] = [];
  let post: string | null = null;
  let pre: string | null = null;
  let inHunk = false;
  const flush = () => {
    const key = post ?? pre;
    if (key && buf.length > 0) out.set(key, buf.join("\n"));
    buf = [];
    post = null;
    pre = null;
    inHunk = false;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      buf.push(line);
      continue;
    }
    buf.push(line);
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    // Headers only before the first hunk; see `parseUnifiedDiff`.
    if (inHunk) continue;
    if (line.startsWith("--- ")) {
      const path = line.slice(4).trim();
      pre = path === "/dev/null" ? null : path.replace(PREFIX, "");
    } else if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      post = path === "/dev/null" ? null : path.replace(PREFIX, "");
    }
  }
  flush();
  return out;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export interface DiffOptions {
  cwd?: string;
  /** Compare against the merge base with this ref, the way a pull request does. */
  base?: string | null;
  staged?: boolean;
}

export interface Diff {
  /** The unified diff, zero context, for the `state`. */
  text: string;
  /** `git diff --stat`, which survives truncation of the text. */
  stat: string;
  ranges: ChangedRanges;
}

/**
 * The change under review.
 *
 * With `base`, `base...HEAD` -- commits that landed on the base branch
 * meanwhile are not this change's doing. Without it, the working tree against
 * HEAD, so a selection can be taken before anything is committed.
 *
 * The prefixes are pinned because a user's `diff.mnemonicPrefix` would
 * otherwise rename them and the parser's paths would match no file.
 */
export async function loadDiff({ cwd = process.cwd(), base = null, staged = false }: DiffOptions = {}): Promise<Diff> {
  // Deletions are NOT filtered out. `parseUnifiedDiff` already drops them
  // from the ranges, because a deleted file has no post-image line for a test
  // body to overlap; but removing a source file is exactly the kind of change
  // the model has to see, so it stays in the text.
  const common = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
  const range: string[] = [];
  if (staged) range.push("--cached");
  if (base) range.push(`${base}...HEAD`);
  else if (!staged) range.push("HEAD");

  const text = await git(["diff", "--unified=0", ...common, ...range], cwd);
  const stat = await git(["diff", "--stat", ...common, ...range], cwd);
  return { text, stat, ranges: parseUnifiedDiff(text) };
}

/**
 * The commit a ref names, or null when it names none -- no repository, no
 * commit yet, or a ref that does not exist.
 *
 * Null rather than a throw: the sha only labels a record, and a run that
 * could select tests must not fail because it could not label them.
 */
export async function resolveSha(ref: string, cwd = process.cwd()): Promise<string | null> {
  try {
    const out = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
